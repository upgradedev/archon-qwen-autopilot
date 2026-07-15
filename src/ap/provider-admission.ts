// Zero-wait, process-wide admission for workflows that can call Qwen providers.
// Public and authenticated-reviewer traffic have physically separate pools, so a
// public burst can never consume the review reserve. A lease spans the complete
// provider workflow (embedding/chat and, for documents, vision + decision loop).

export type ProviderRunTier = "public" | "reviewer";

export interface ProviderRunLease {
  readonly tier: ProviderRunTier;
  // Transfer ownership of an in-flight provider operation to the lease when the
  // HTTP/MCP request has already reached its own hard response deadline. Calling
  // release() then waits for every retained operation to settle. A provider that
  // ignores cancellation therefore poisons only its already-consumed slot instead
  // of allowing invisible concurrency to exceed the configured cap.
  retainUntilSettled(operation: Promise<unknown>): void;
  release(): void;
}

export interface ProviderRunAdmission {
  tryAcquire(tier: ProviderRunTier): ProviderRunLease | null;
}

export interface DocumentRenderLease {
  // A timed-out vision SDK call can retain rendered/base64 document buffers even
  // after the HTTP response returns. Keep this memory slot occupied until that
  // detached operation really settles.
  retainUntilSettled(operation: Promise<unknown>): void;
  release(): void;
}

export interface DocumentRenderAdmission {
  tryAcquire(): DocumentRenderLease | null;
}

export class TieredProviderRunAdmission implements ProviderRunAdmission {
  private readonly active: Record<ProviderRunTier, number> = { public: 0, reviewer: 0 };

  constructor(
    private readonly limits: Record<ProviderRunTier, number> = {
      public: boundedEnvInt("PUBLIC_PROVIDER_RUN_CONCURRENCY", 2, 1, 32),
      reviewer: boundedEnvInt("REVIEWER_PROVIDER_RUN_CONCURRENCY", 2, 1, 32),
    }
  ) {
    this.limits = {
      public: boundedInt(limits.public, 1, 32),
      reviewer: boundedInt(limits.reviewer, 1, 32),
    };
  }

  tryAcquire(tier: ProviderRunTier): ProviderRunLease | null {
    if (this.active[tier] >= this.limits[tier]) return null;
    this.active[tier] += 1;
    let releaseRequested = false;
    let released = false;
    let retained = 0;
    const finishRelease = () => {
      if (released || !releaseRequested || retained > 0) return;
      released = true;
      this.active[tier] = Math.max(0, this.active[tier] - 1);
    };
    return {
      tier,
      retainUntilSettled: (operation) => {
        if (released) {
          throw new Error("cannot retain a provider operation after its admission lease was released");
        }
        retained += 1;
        // Observe both fulfillment and rejection so a detached SDK promise can
        // never become an unhandled rejection. `finally` alone would create a new
        // rejecting promise, hence the explicit two-branch settlement handler.
        void operation.then(
          () => {
            retained = Math.max(0, retained - 1);
            finishRelease();
          },
          () => {
            retained = Math.max(0, retained - 1);
            finishRelease();
          }
        );
      },
      release: () => {
        if (releaseRequested) return;
        releaseRequested = true;
        finishRelease();
      },
    };
  }

  snapshot(): Readonly<Record<ProviderRunTier, { active: number; limit: number }>> {
    return {
      public: { active: this.active.public, limit: this.limits.public },
      reviewer: { active: this.active.reviewer, limit: this.limits.reviewer },
    };
  }
}

// One singleton per Node process/Function Compute instance. Tests can inject an
// isolated pool into buildServer without weakening production's process-wide cap.
const PROCESS_ADMISSION = new TieredProviderRunAdmission();

export function defaultProviderRunAdmission(): ProviderRunAdmission {
  return PROCESS_ADMISSION;
}

// PDF/image extraction has a separate aggregate memory budget shared by public
// and reviewer traffic. Tier isolation protects reviewer availability, while this
// global cap prevents the two provider pools from rendering four large PDFs at
// once in the same 512 MiB container.
export class BoundedDocumentRenderAdmission implements DocumentRenderAdmission {
  private active = 0;
  private readonly limit: number;

  constructor(limit = boundedEnvInt("DOCUMENT_RENDER_CONCURRENCY", 2, 1, 4)) {
    this.limit = boundedInt(limit, 1, 4);
  }

  tryAcquire(): DocumentRenderLease | null {
    if (this.active >= this.limit) return null;
    this.active += 1;
    let releaseRequested = false;
    let released = false;
    let retained = 0;
    const finishRelease = () => {
      if (released || !releaseRequested || retained > 0) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
    };
    return {
      retainUntilSettled: (operation) => {
        if (released) throw new Error("cannot retain a document operation after its admission lease was released");
        retained += 1;
        void operation.then(
          () => {
            retained = Math.max(0, retained - 1);
            finishRelease();
          },
          () => {
            retained = Math.max(0, retained - 1);
            finishRelease();
          }
        );
      },
      release: () => {
        if (releaseRequested) return;
        releaseRequested = true;
        finishRelease();
      },
    };
  }

  snapshot(): Readonly<{ active: number; limit: number }> {
    return { active: this.active, limit: this.limit };
  }
}

const PROCESS_DOCUMENT_ADMISSION = new BoundedDocumentRenderAdmission();

export function defaultDocumentRenderAdmission(): DocumentRenderAdmission {
  return PROCESS_DOCUMENT_ADMISSION;
}

function boundedEnvInt(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? boundedInt(parsed, min, max) : fallback;
}

function boundedInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.trunc(value)));
}
