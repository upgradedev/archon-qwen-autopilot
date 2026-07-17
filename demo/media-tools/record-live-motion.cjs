#!/usr/bin/env node
/*
 * Record genuine, secret-free Autopilot browser interaction footage.
 *
 * Production mode requires the passed final CAPTURE_REVIEW for the same exact
 * deployed runtime SHA and pinned public URL. It deliberately does not read or
 * use the reviewer credential: the visible flow is the real isolated public preview,
 * which streams the Qwen evidence loop but creates no durable PENDING work item and
 * exposes no human-decision control. Raw/highlight footage stays under ignored
 * .artifacts and is hash-bound for the final compositor.
 */
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_URL = 'https://autopilot.43.106.13.19.sslip.io';
const DEFAULT_VIDEO = '.artifacts/final-video/autopilot-live-interaction.mp4';
const DEFAULT_MANIFEST = '.artifacts/final-video/autopilot-live-interaction.manifest.json';
const DEFAULT_POSTER = '.artifacts/final-video/autopilot-live-interaction-poster.png';
const SHA_RE = /^[0-9a-f]{40}$/;
const HIGHLIGHT_WINDOW_SECONDS = 9;
const HIGHLIGHT_ACTION_PREROLL_SECONDS = 1;
const HIGHLIGHT_ACTION_POSTROLL_SECONDS = 1.25;
const HIGHLIGHT_BOUNDARY_TAIL_SECONDS = 4;
const ALLOWED_TRACE_TOOLS = Object.freeze([
  'recall_vendor_history',
  'validate_invoice',
  'check_duplicate',
  'compute_variance_vs_history',
  'request_more_context',
]);
const REQUIRED_CORE_TRACE_TOOLS = Object.freeze(['recall_vendor_history', 'validate_invoice']);

function fail(message) { throw new Error(message); }

function insideRepo(value, label, { mustExist = false } = {}) {
  const resolved = path.resolve(ROOT, value);
  const rel = path.relative(ROOT, resolved);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    fail(`${label} must stay inside this repository`);
  }
  if (mustExist) {
    const stats = fs.lstatSync(resolved);
    assert.equal(stats.isFile(), true, `${label} must be a regular file`);
    assert.equal(stats.isSymbolicLink(), false, `${label} must not be a symlink`);
    assert.equal(stats.nlink, 1, `${label} must have exactly one hard link`);
  }
  return resolved;
}

function relative(file) { return path.relative(ROOT, file).replaceAll('\\', '/'); }

function sha256(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function immutableFileSnapshot(file, label) {
  const resolved = insideRepo(file, label, { mustExist: true });
  const canonicalRoot = fs.realpathSync.native(ROOT);
  const canonical = fs.realpathSync.native(resolved);
  const identity = (value) => os.platform() === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  assert.equal(identity(resolved), identity(canonical), `${label} path and every ancestor must be canonical and non-symlinked`);
  const relativeTarget = path.relative(canonicalRoot, canonical);
  assert.ok(relativeTarget && relativeTarget !== '..' && !relativeTarget.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeTarget),
    `${label} canonical target must stay inside this repository`);
  const noFollow = Number.isInteger(fs.constants.O_NOFOLLOW) ? fs.constants.O_NOFOLLOW : 0;
  const descriptor = fs.openSync(canonical, fs.constants.O_RDONLY | noFollow);
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    assert.equal(before.isFile(), true, `${label} must be a regular file`);
    assert.equal(before.nlink, 1n, `${label} must have exactly one hard link`);
    assert.ok(before.size > 0n && before.size <= 16n * 1024n * 1024n, `${label} has an invalid size`);
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    const fingerprint = (stats) => [stats.dev, stats.ino, stats.nlink, stats.size, stats.mtimeNs, stats.ctimeNs];
    assert.deepEqual(fingerprint(after), fingerprint(before), `${label} changed while it was being read`);
    assert.equal(BigInt(bytes.length), before.size, `${label} descriptor returned a partial read`);
    const afterCanonical = fs.realpathSync.native(resolved);
    assert.equal(identity(afterCanonical), identity(canonical), `${label} canonical target changed while it was being read`);
    assert.deepEqual(fingerprint(fs.statSync(afterCanonical, { bigint: true })), fingerprint(before),
      `${label} pathname no longer identifies the descriptor-read file`);
    return { bytes, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  } finally {
    fs.closeSync(descriptor);
  }
}

function readJsonSnapshot(file, label) {
  const snapshot = immutableFileSnapshot(file, label);
  let payload;
  try { payload = JSON.parse(snapshot.bytes.toString('utf8')); }
  catch { fail(`${label} is not valid UTF-8 JSON`); }
  assert.equal(payload && typeof payload === 'object' && !Array.isArray(payload), true, `${label} must be a JSON object`);
  return { ...snapshot, payload };
}

function atomicJson(file, payload) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomBytes(12).toString('hex')}.writing`);
  fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  fs.renameSync(temporary, file);
}

function exactOrigin(raw) {
  const parsed = new URL(String(raw || ''));
  assert.equal(parsed.origin, DEFAULT_URL, `live origin must equal pinned ${DEFAULT_URL}`);
  assert.equal(parsed.href, `${DEFAULT_URL}/`, 'live origin must contain no path, query, fragment or credentials');
  return DEFAULT_URL;
}

function validateRelevantTraceTools(rawTools, label) {
  assert.ok(Array.isArray(rawTools), `${label} trace tools must be an array`);
  const tools = rawTools.map((tool) => String(tool || ''));
  assert.ok(tools.length >= 2, `${label} must contain at least two read/analyze steps`);
  assert.equal(tools[0], 'recall_vendor_history', `${label} must establish vendor history first`);
  for (const tool of tools) assert.ok(ALLOWED_TRACE_TOOLS.includes(tool), `${label} contains a non-read/analyze trace step`);
  for (const required of REQUIRED_CORE_TRACE_TOOLS) assert.ok(tools.includes(required), `${label} is missing core trace step ${required}`);
  return tools;
}

function validateEvidence(file, expectedSha, baseUrl, fixture) {
  const snapshot = readJsonSnapshot(file, 'CAPTURE_REVIEW');
  const payload = snapshot.payload;
  assert.equal(payload.status, 'passed', 'CAPTURE_REVIEW status is not passed');
  assert.equal(payload.deployedRuntimeSha, expectedSha, 'CAPTURE_REVIEW deployed runtime SHA mismatch');
  if (!fixture) {
    assert.equal(payload.schemaVersion, 3, 'CAPTURE_REVIEW schema version is not 3');
    assert.match(String(payload.captureSourceHead || ''), SHA_RE,
      'CAPTURE_REVIEW capture-source HEAD is missing or invalid');
    assert.equal(payload.releaseEvidence && payload.releaseEvidence.schema,
      'cloud-assistant-sentinel-v1', 'CAPTURE_REVIEW release-evidence schema mismatch');
    assert.equal(payload.publicUrl, baseUrl, 'CAPTURE_REVIEW public URL mismatch');
    assert.equal(payload.gates && payload.gates.pendingCleanupZero, true, 'CAPTURE_REVIEW does not prove zero capture PENDING residue');
    assert.equal(payload.reviewerCredentialStored, false, 'CAPTURE_REVIEW does not prove credential non-storage');
    assert.equal(payload.models && payload.models.decision, 'qwen-plus', 'CAPTURE_REVIEW decision model is not qwen-plus');
    assert.equal(
      payload.canaries && payload.canaries.decision && payload.canaries.decision.tracePolicy,
      'relevant-side-effect-free-subset',
      'CAPTURE_REVIEW decision canary trace policy mismatch',
    );
    validateRelevantTraceTools(
      payload.canaries && payload.canaries.decision && payload.canaries.decision.traceTools,
      'CAPTURE_REVIEW decision canary',
    );
  }
  return snapshot;
}

function run(file, args, label, options = {}) {
  try {
    return execFileSync(file, args, { cwd: ROOT, encoding: options.binary ? null : 'utf8', maxBuffer: 256 * 1024 * 1024 });
  } catch (error) {
    const diagnostic = String(error.stderr || error.message || '').slice(-3000);
    fail(`${label} failed: ${diagnostic}`);
  }
}

function mediaSummary(file) {
  const payload = JSON.parse(run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], `ffprobe ${relative(file)}`));
  const streams = payload.streams || [];
  const videos = streams.filter((stream) => stream.codec_type === 'video');
  const audios = streams.filter((stream) => stream.codec_type === 'audio');
  assert.equal(videos.length, 1, `${relative(file)} must have exactly one video stream`);
  const video = videos[0];
  const duration = Number(payload.format && payload.format.duration || video.duration || 0);
  assert.ok(Number.isFinite(duration) && duration > 0, `${relative(file)} has no positive duration`);
  return {
    durationSeconds: Number(duration.toFixed(6)),
    videoStreamCount: videos.length,
    audioStreamCount: audios.length,
    width: Number(video.width || 0),
    height: Number(video.height || 0),
    videoCodec: video.codec_name || null,
    pixelFormat: video.pix_fmt || null,
    averageFrameRate: video.avg_frame_rate || null,
    frameCount: /^\d+$/.test(String(video.nb_frames || '')) ? Number(video.nb_frames) : null,
  };
}

function frameDiversity(file, maxDuration = 30) {
  const output = run('ffmpeg', ['-v', 'error', '-i', file, '-t', String(maxDuration), '-vf', 'fps=2,scale=320:-2', '-an', '-f', 'framemd5', '-'], `frame diversity ${relative(file)}`);
  const hashes = output.split(/\r?\n/).filter((line) => line && !line.startsWith('#')).map((line) => line.split(',').at(-1).trim()).filter((value) => /^[0-9a-f]{32}$/.test(value));
  assert.ok(hashes.length >= 8, 'recording produced too few frame-diversity samples');
  const unique = new Set(hashes).size;
  let longest = 1;
  let current = 1;
  for (let index = 1; index < hashes.length; index += 1) {
    current = hashes[index] === hashes[index - 1] ? current + 1 : 1;
    longest = Math.max(longest, current);
  }
  return {
    sampleRateFps: 2,
    samples: hashes.length,
    uniqueFrames: unique,
    uniqueRatio: Number((unique / hashes.length).toFixed(4)),
    longestIdenticalRunSamples: longest,
  };
}

async function addRecordingOverlay(page) {
  await page.evaluate(() => {
    const badge = document.createElement('div');
    badge.id = 'archon-capture-live-badge';
    badge.textContent = 'LIVE HTTPS · ISOLATED PUBLIC PREVIEW';
    badge.style.cssText = 'position:fixed;right:28px;top:24px;z-index:2147483646;background:#080d14ee;color:#86efac;border:1px solid #34d399;border-radius:999px;padding:10px 16px;font:700 18px system-ui;letter-spacing:.04em;pointer-events:none';
    const cursor = document.createElement('div');
    cursor.id = 'archon-capture-cursor';
    cursor.style.cssText = 'position:fixed;left:-30px;top:-30px;width:22px;height:22px;z-index:2147483647;border-radius:50%;border:3px solid #fff;box-shadow:0 0 0 4px #10b981aa;pointer-events:none;transform:translate(-50%,-50%)';
    document.documentElement.append(badge, cursor);
    addEventListener('mousemove', (event) => { cursor.style.left = `${event.clientX}px`; cursor.style.top = `${event.clientY}px`; }, { passive: true });
    addEventListener('mousedown', () => { cursor.style.background = '#34d399'; });
    addEventListener('mouseup', () => { cursor.style.background = 'transparent'; });
  });
}

function mark(actions, started, action) {
  actions.push({ atSeconds: Number(((Date.now() - started) / 1000).toFixed(3)), action });
}

async function recordLive(page, baseUrl, poster) {
  const started = Date.now();
  const actions = [];
  await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle', timeout: 90_000 });
  assert.equal(new URL(page.url()).origin, baseUrl, 'navigation left the pinned public origin');
  await addRecordingOverlay(page);
  const token = page.locator('#reviewerToken');
  assert.equal(await token.count(), 1, 'reviewer token field is missing');
  assert.equal(await token.inputValue(), '', 'reviewer token field is not blank');
  mark(actions, started, 'loaded live public Autopilot with reviewer workspace locked');
  await page.waitForTimeout(900);

  const synthetic = {
    vendor: 'SOTA Video Public Preview',
    invoice_number: `VID-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`,
    invoice_date: '2026-07-16',
    currency: 'EUR',
    tax_id: 'SYNTHETIC-DEMO-ONLY',
    subtotal: 4200,
    tax: 1008,
    total: 5208,
    line_items: [{ description: 'Original synthetic observability service', quantity: 1, unit_price: 4200, amount: 4200 }],
  };
  const invoice = page.locator('#invoiceInput');
  await invoice.fill(JSON.stringify(synthetic, null, 2));
  await invoice.press('End');
  mark(actions, started, 'entered an original synthetic invoice in the public UI');
  await page.waitForTimeout(650);
  await page.locator('#processBtn').click();
  mark(actions, started, 'clicked Process invoice to start the live Qwen evidence loop');
  await page.locator('#processView').waitFor({ state: 'visible', timeout: 30_000 });
  await page.waitForFunction(() => /Proposal generated in isolated preview mode\./i.test(document.querySelector('#processView')?.innerText || ''), null, { timeout: 300_000 });
  const visibleTraceTools = (await page.locator('#processView .proc-step .tool').allInnerTexts()).map((tool) => tool.trim());
  validateRelevantTraceTools(visibleTraceTools, 'visible public preview');
  mark(actions, started, `observed relevant read/analyze steps stream into the UI: ${visibleTraceTools.join(' → ')}`);
  const processText = await page.locator('#processView').innerText();
  for (const tool of visibleTraceTools) {
    assert.match(processText, new RegExp(`(^|\\s)${tool}(\\s|$)`, 'm'), `visible public preview omitted ${tool}`);
  }
  assert.match(processText, /Isolated preview — nothing persisted/i, 'public preview boundary is not visible');
  assert.match(processText, /No approve, amend, or reject controls are available/i, 'structural public-preview boundary is not visible');
  assert.equal(await token.inputValue(), '', 'reviewer token field changed during recording');
  await page.locator('#processView').scrollIntoViewIfNeeded();
  mark(actions, started, 'showed the completed non-durable proposal and human-boundary copy');
  await page.waitForTimeout(2200);
  await page.screenshot({ path: poster, fullPage: false, animations: 'disabled' });
  return { actions, visibleTraceTools };
}

async function recordFixture(page, poster) {
  await page.setContent(`<!doctype html><html><style>
    body{margin:0;background:#0d1117;color:#e6edf3;font:28px system-ui}main{padding:80px 150px}textarea{width:80%;height:220px;font:24px ui-monospace;padding:18px}button{font:28px system-ui;padding:18px;background:#34d399}.step,.preview{opacity:0;transform:translateY(20px);transition:.45s;margin:16px;padding:16px;background:#161b22}.shown{opacity:1;transform:none}</style><main>
    <h1>SELF-TEST · NOT SUBMISSION EVIDENCE</h1><textarea id=invoiceInput></textarea><button id=processBtn>Process invoice</button>
    <section id=processView><div class=step>recall_vendor_history</div><div class=step>validate_invoice</div><div class=step>check_duplicate</div><div class=step>compute_variance_vs_history</div><div class=preview>Isolated preview — nothing persisted.</div></section>
    <script>processBtn.onclick=()=>[...document.querySelectorAll('.step,.preview')].forEach((el,i)=>setTimeout(()=>el.classList.add('shown'),i*350))</script></main></html>`);
  await addRecordingOverlay(page);
  const started = Date.now();
  const actions = [];
  await page.locator('#invoiceInput').pressSequentially('{ "synthetic": true, "total": 5208 }', { delay: 30 });
  mark(actions, started, 'fixture typed invoice');
  await page.locator('#processBtn').click();
  mark(actions, started, 'fixture clicked process');
  await page.locator('.preview.shown').waitFor({ state: 'visible' });
  // Keep the raw fixture longer than the nine-second publication window so the
  // self-test exercises action-timestamp selection instead of the whole-file path.
  await page.waitForTimeout(7000);
  mark(actions, started, 'fixture observed relevant read/analyze steps stream into the UI');
  mark(actions, started, 'fixture showed the completed non-durable proposal and human-boundary copy');
  await page.waitForTimeout(1200);
  await page.screenshot({ path: poster });
  return { actions, visibleTraceTools: ['recall_vendor_history', 'validate_invoice', 'check_duplicate', 'compute_variance_vs_history'] };
}

function requiredAction(actions, pattern, label) {
  const matches = actions.filter((entry) => pattern.test(String(entry?.action || '')));
  assert.equal(matches.length, 1, `recording must contain exactly one ${label} action`);
  const atSeconds = Number(matches[0].atSeconds);
  assert.ok(Number.isFinite(atSeconds) && atSeconds >= 0, `${label} action timestamp is invalid`);
  return { label, atSeconds, action: matches[0].action };
}

function segmentContains(segments, atSeconds) {
  return segments.some(([start, end]) => atSeconds >= start - 0.001 && atSeconds <= end + 0.001);
}

function createHighlight(raw, output, actions, { fixture = false } = {}) {
  const rawMedia = mediaSummary(raw);
  const duration = rawMedia.durationSeconds;
  const entry = requiredAction(
    actions,
    fixture ? /fixture typed invoice/i : /entered an original synthetic invoice in the public UI/i,
    'invoice-entry',
  );
  const click = requiredAction(
    actions,
    fixture ? /fixture clicked process/i : /clicked Process invoice to start the live Qwen evidence loop/i,
    'process-click',
  );
  const required = [
    entry,
    click,
    requiredAction(
      actions,
      fixture ? /fixture observed relevant read\/analyze steps stream into the UI/i
        : /observed relevant read\/analyze steps stream into the UI/i,
      'streamed-evidence',
    ),
    requiredAction(
      actions,
      fixture ? /fixture showed the completed non-durable proposal and human-boundary copy/i
        : /showed the completed non-durable proposal and human-boundary copy/i,
      'completed-boundary',
    ),
  ];
  for (const action of required) {
    assert.ok(action.atSeconds <= duration + 0.001, `${action.label} timestamp is outside the raw recording`);
  }

  let sourceSegments;
  if (duration <= HIGHLIGHT_WINDOW_SECONDS + 1e-6) {
    sourceSegments = [[0, duration]];
  } else {
    const interactionStart = Math.max(0, entry.atSeconds - HIGHLIGHT_ACTION_PREROLL_SECONDS);
    const interactionEnd = Math.min(duration, click.atSeconds + HIGHLIGHT_ACTION_POSTROLL_SECONDS);
    assert.ok(interactionStart < interactionEnd, 'invoice-entry/process-click segment is empty');
    const boundaryStart = Math.max(0, duration - HIGHLIGHT_BOUNDARY_TAIL_SECONDS);
    sourceSegments = interactionEnd >= boundaryStart
      ? [[interactionStart, duration]]
      : [[interactionStart, interactionEnd], [boundaryStart, duration]];
  }
  const retainedDuration = sourceSegments.reduce((total, [start, end]) => total + end - start, 0);
  assert.ok(retainedDuration <= HIGHLIGHT_WINDOW_SECONDS + 1e-6,
    'required interaction and completed-boundary footage cannot fit the canonical 9-second window');
  for (const action of required) {
    assert.ok(segmentContains(sourceSegments, action.atSeconds),
      `${action.label} action is not covered by a retained source segment`);
  }

  const args = ['-y', '-v', 'error', '-i', raw];
  const keepsWholeRecording = sourceSegments.length === 1
    && sourceSegments[0][0] === 0
    && Math.abs(sourceSegments[0][1] - duration) <= 1e-6;
  if (!keepsWholeRecording) {
    const trims = sourceSegments.map(([start, end], index) =>
      `[0:v]trim=start=${start.toFixed(6)}:end=${end.toFixed(6)},setpts=PTS-STARTPTS[segment${index}]`);
    const inputs = sourceSegments.map((_, index) => `[segment${index}]`).join('');
    const join = sourceSegments.length === 1
      ? `${inputs}fps=30,scale=1920:1080:flags=lanczos[video]`
      : `${inputs}concat=n=${sourceSegments.length}:v=1:a=0,fps=30,scale=1920:1080:flags=lanczos[video]`;
    args.push('-filter_complex', `${trims.join(';')};${join}`, '-map', '[video]');
  } else {
    args.push('-vf', 'fps=30,scale=1920:1080:flags=lanczos');
  }
  args.push('-an', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-map_metadata', '-1', '-movflags', '+faststart', output);
  run('ffmpeg', args, 'build browser-interaction highlight');
  const finalSegment = sourceSegments[sourceSegments.length - 1];
  return {
    rawDurationSeconds: duration,
    highlightWindowSeconds: HIGHLIGHT_WINDOW_SECONDS,
    selectionStrategy: 'required-action coverage plus completed-boundary tail',
    sourceSegments,
    retainedDurationSeconds: Number(retainedDuration.toFixed(6)),
    requiredActionCoverage: required.map(({ label, atSeconds }) => ({ label, atSeconds, retained: true })),
    finalBoundaryTailSeconds: Number((finalSegment[1] - finalSegment[0]).toFixed(6)),
    finalSourceFrameRetained: Math.abs(finalSegment[1] - duration) <= 0.001,
  };
}

async function capture({ expectedSha, evidenceFile, baseUrl, output, manifestFile, poster, replace, fixture }) {
  assert.match(expectedSha, SHA_RE, 'expected SHA must be 40 lowercase hex characters');
  const evidenceSnapshot = validateEvidence(evidenceFile, expectedSha, baseUrl, fixture);
  const evidence = evidenceSnapshot.payload;
  if (!fixture) assert.equal(relative(output).startsWith('.artifacts/final-video/'), true, 'live video must stay under .artifacts/final-video');
  for (const file of [output, manifestFile, poster]) {
    if (!replace && fs.existsSync(file)) fail(`refusing to replace existing ${relative(file)} without --replace`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const runtime = insideRepo('.artifacts/final-video/autopilot-recording-runtime', 'recording runtime');
  fs.rmSync(runtime, { recursive: true, force: true });
  fs.mkdirSync(runtime, { recursive: true });
  const capturedAt = new Date().toISOString();
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    screen: { width: 1920, height: 1080 },
    ignoreHTTPSErrors: false,
    recordVideo: { dir: runtime, size: { width: 1920, height: 1080 } },
  });
  if (!fixture) {
    await context.addInitScript(() => { try { localStorage.setItem('archon_autopilot_tour_v1', 'done'); } catch (_) {} });
    await context.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if ((url.protocol === 'http:' || url.protocol === 'https:') && url.origin !== baseUrl) await route.abort();
      else await route.continue();
    });
  }
  const page = await context.newPage();
  page.setDefaultTimeout(90_000);
  const recording = fixture ? await recordFixture(page, poster) : await recordLive(page, baseUrl, poster);
  const actions = recording.actions;
  const video = page.video();
  await page.close();
  await context.close();
  assert.ok(video, 'Playwright did not create a video handle');
  const raw = await video.path();
  await browser.close();
  assert.ok(fs.statSync(raw).size > 10_000, 'raw browser recording is missing or empty');
  const highlight = createHighlight(raw, output, actions, { fixture });
  const media = mediaSummary(output);
  assert.deepEqual([media.width, media.height], [1920, 1080], 'highlight is not 1920x1080');
  assert.equal(media.audioStreamCount, 0, 'highlight unexpectedly contains audio');
  assert.ok(media.durationSeconds >= 4, 'highlight is too short to prove interaction');
  assert.ok(media.durationSeconds <= HIGHLIGHT_WINDOW_SECONDS + 1e-6,
    'highlight exceeds the canonical 9-second compositor window');
  assert.equal(highlight.finalSourceFrameRetained, true, 'highlight omitted the completed final browser state');
  if (highlight.rawDurationSeconds > HIGHLIGHT_WINDOW_SECONDS + 0.05) {
    assert.ok(highlight.finalBoundaryTailSeconds >= HIGHLIGHT_BOUNDARY_TAIL_SECONDS - 0.01,
      'highlight did not retain the final four-second human-boundary hold');
  }
  if (!fixture) {
    assert.ok(actions.some((entry) => /completed non-durable proposal and human-boundary copy/i.test(entry.action)),
      'interaction log does not attest the completed proposal and human-boundary state');
  }
  const motion = frameDiversity(output, Math.min(media.durationSeconds, 30));
  assert.ok(motion.uniqueFrames >= 8 && motion.uniqueRatio >= 0.25, 'highlight is too static to prove genuine interaction');
  assert.equal(sha256(evidenceFile), evidenceSnapshot.sha256,
    'CAPTURE_REVIEW changed after validation while live motion was being recorded');
  const manifest = {
    schemaVersion: 1,
    status: 'passed',
    mode: fixture ? 'fixture' : 'live',
    submissionEligible: !fixture,
    expectedRuntimeSha: expectedSha,
    publicUrl: baseUrl,
    capturedAt,
    finishedAt: new Date().toISOString(),
    evidenceManifestPath: relative(evidenceFile),
    evidenceManifestSha256: evidenceSnapshot.sha256,
    reviewerCredentialUsed: false,
    reviewerCredentialRendered: false,
    durableReviewerWritesCreated: false,
    publicFlow: fixture ? 'fixture only' : 'real isolated non-durable preview',
    boundDecisionCanary: fixture ? null : {
      modelId: evidence.models.decision,
      traceTools: evidence.canaries.decision.traceTools,
      captureReviewSha256: evidenceSnapshot.sha256,
    },
    visibleTraceTools: recording.visibleTraceTools,
    actions,
    edit: { type: 'truth-preserving action/tail selection only', ...highlight },
    rawVideo: { path: relative(output), sha256: sha256(output), bytes: fs.statSync(output).size, ...media },
    frameDiversity: motion,
    poster: { path: relative(poster), sha256: sha256(poster), bytes: fs.statSync(poster).size },
  };
  atomicJson(manifestFile, manifest);
  fs.rmSync(runtime, { recursive: true, force: true });
  return manifest;
}

function argument(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || '') : fallback;
}

async function selfTest() {
  const root = insideRepo('.artifacts/final-video/autopilot-recorder-selftest', 'self-test root');
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  const expectedSha = '1'.repeat(40);
  assert.deepEqual(
    validateRelevantTraceTools(['recall_vendor_history', 'validate_invoice'], 'self-test trace'),
    ['recall_vendor_history', 'validate_invoice'],
  );
  assert.throws(
    () => validateRelevantTraceTools(['recall_vendor_history', 'draft_payment'], 'unsafe self-test trace'),
    /non-read\/analyze trace step/,
  );
  const evidence = path.join(root, 'CAPTURE_REVIEW.json');
  fs.writeFileSync(evidence, `${JSON.stringify({ status: 'passed', deployedRuntimeSha: expectedSha })}\n`);
  const manifest = await capture({ expectedSha, evidenceFile: evidence, baseUrl: DEFAULT_URL,
    output: path.join(root, 'fixture.mp4'), manifestFile: path.join(root, 'fixture.manifest.json'),
    poster: path.join(root, 'fixture-poster.png'), replace: false, fixture: true });
  assert.ok(manifest.edit.rawDurationSeconds > HIGHLIGHT_WINDOW_SECONDS,
    'self-test raw fixture did not exercise action-aware trimming');
  assert.equal(manifest.edit.selectionStrategy, 'required-action coverage plus completed-boundary tail');
  assert.equal(manifest.edit.requiredActionCoverage.length, 4,
    'self-test did not require the entry, click, streamed-evidence, and completed-boundary actions');
  assert.ok(manifest.edit.requiredActionCoverage.every((entry) => entry.retained === true),
    'self-test action-aware highlight omitted a required action');
  const originalEvidence = fs.readFileSync(evidence);
  const evidenceMutation = setTimeout(() => {
    fs.writeFileSync(evidence, `${JSON.stringify({
      status: 'passed', deployedRuntimeSha: expectedSha, changedDuringRecording: true,
    })}\n`);
  }, 1_000);
  try {
    await assert.rejects(
      capture({
        expectedSha,
        evidenceFile: evidence,
        baseUrl: DEFAULT_URL,
        output: path.join(root, 'mutated-evidence-fixture.mp4'),
        manifestFile: path.join(root, 'mutated-evidence-fixture.manifest.json'),
        poster: path.join(root, 'mutated-evidence-fixture-poster.png'),
        replace: false,
        fixture: true,
      }),
      /CAPTURE_REVIEW changed after validation while live motion was being recorded/,
      'recording must fail instead of hash-binding CAPTURE_REVIEW bytes that were not validated',
    );
  } finally {
    clearTimeout(evidenceMutation);
    fs.writeFileSync(evidence, originalEvidence);
  }
  process.stdout.write('Autopilot live recorder self-test: PASS · real browser video · 1920x1080 · no audio · frame diversity\n');
}

async function main() {
  if (process.argv.includes('--self-test')) return selfTest();
  const expectedSha = argument('--expected-sha');
  if (!expectedSha) fail('--expected-sha is required');
  const baseUrl = exactOrigin(argument('--base-url', DEFAULT_URL));
  const replace = process.argv.includes('--replace');
  const manifest = await capture({
    expectedSha,
    evidenceFile: insideRepo(argument('--capture-review', 'demo/gallery/CAPTURE_REVIEW.json'), 'CAPTURE_REVIEW', { mustExist: true }),
    baseUrl,
    output: insideRepo(argument('--output', DEFAULT_VIDEO), 'output'),
    manifestFile: insideRepo(argument('--manifest', DEFAULT_MANIFEST), 'manifest'),
    poster: insideRepo(argument('--poster', DEFAULT_POSTER), 'poster'),
    replace,
    fixture: false,
  });
  process.stdout.write(`Autopilot live recorder: PASS · ${manifest.rawVideo.durationSeconds.toFixed(3)}s · ${manifest.rawVideo.sha256.slice(0, 12)} · isolated preview · no reviewer credential\n`);
}

main().catch((error) => {
  process.stderr.write(`Autopilot live recorder: FAIL · ${error.message}\n`);
  process.exitCode = 2;
});
