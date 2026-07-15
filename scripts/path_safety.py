"""Repository-contained path resolution for Python artifact readers/writers.

Relative inputs are rooted at the repository, not the caller's working directory.
``realpath`` resolves existing symlink/junction components, including the deepest
existing parent of a not-yet-created output, so an in-repository link cannot route
an artifact outside the checkout.
"""

from __future__ import annotations

import argparse
import os


REPO_ROOT = os.path.realpath(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def repo_contained_path(
    value: str,
    label: str,
    repo_root: str = REPO_ROOT,
    *,
    must_exist: bool = False,
) -> str:
    if not isinstance(value, str) or not value.strip():
        raise SystemExit(f"{label} must be a non-empty path inside this repository")

    root = os.path.realpath(repo_root)
    candidate = value if os.path.isabs(value) else os.path.join(root, value)
    resolved = os.path.realpath(candidate)
    try:
        inside = os.path.normcase(os.path.commonpath([root, resolved])) == os.path.normcase(root)
    except ValueError:  # Different drives on Windows.
        inside = False
    if not inside:
        raise SystemExit(f"{label} must resolve inside this repository")
    if must_exist and not os.path.exists(resolved):
        raise SystemExit(f"{label} must name an existing path inside this repository")
    return resolved


def main() -> int:
    parser = argparse.ArgumentParser(description="Resolve one repository-contained path")
    parser.add_argument("--label", default="path")
    parser.add_argument("--must-exist", action="store_true")
    parser.add_argument("path")
    args = parser.parse_args()
    print(repo_contained_path(args.path, args.label, must_exist=args.must_exist))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
