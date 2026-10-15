"""Build a public submission from an explicit file allowlist, using only stdlib.

No directory is copied recursively. Existing output names are never overwritten.
The clean directory is a repository root; the ZIP adds mcd-social-to-meal/ around it.
"""
from __future__ import annotations

import argparse
import hashlib
from pathlib import Path, PurePosixPath
import re
import stat
import sys
import zipfile


PROJECT = Path(__file__).resolve().parent.parent
ARCHIVE_ROOT = "mcd-social-to-meal"
DEFAULT_NAME = "mcd-social-to-meal-submission-2026-10-15"
BLOCKED_PARTS = {
    "private", "artifacts", ".git", ".codex", ".agents", "dist",
    "node_modules", "__pycache__", ".tmp",
}
REQUIRED_FILES = {
    "README.md", "SUBMISSION.md", "SKILL.md", "CONTEST_DECLARATION.md",
    "MCP_INTEGRATION.md", "LICENSE", "mcp-config.example.json",
    "scripts/package_submission.py", "submission-files.txt",
}
WINDOWS_RESERVED = {"CON", "PRN", "AUX", "NUL"} | {
    f"{prefix}{number}" for prefix in ("COM", "LPT") for number in range(1, 10)
}


class PackageError(Exception):
    """A safe, actionable packaging failure."""


def is_inside(path: Path, directory: Path) -> bool:
    try:
        path.relative_to(directory)
        return True
    except ValueError:
        return False


def reject_links(path: Path) -> None:
    """Reject symbolic links and Windows reparse points, including ancestors."""
    for part in (path, *path.parents):
        try:
            info = part.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            raise PackageError(f"Links or reparse points are not allowed: {part}")


def checked_source(relative: str) -> Path:
    if (not relative or "\\" in relative or ":" in relative
            or any(ord(char) < 32 for char in relative)):
        raise PackageError(f"Invalid allowlist path: {relative!r}")
    portable = PurePosixPath(relative)
    if (portable.is_absolute() or portable.as_posix() != relative
            or any(part in {".", ".."} for part in portable.parts)):
        raise PackageError(f"Non-canonical allowlist path: {relative!r}")
    for part in portable.parts:
        lower = part.casefold()
        if (lower in BLOCKED_PARTS or lower == ".env" or lower.startswith(".env.")
                or part.rstrip(". ") != part or any(char in part for char in '<>"|?*')
                or part.split(".", 1)[0].upper() in WINDOWS_RESERVED):
            raise PackageError(f"Private or unsafe allowlist path: {relative!r}")
    candidate = PROJECT.joinpath(*portable.parts)
    reject_links(candidate)
    try:
        resolved = candidate.resolve(strict=True)
    except FileNotFoundError as error:
        raise PackageError(f"Required public file is missing: {relative}") from error
    if not is_inside(resolved, PROJECT) or not resolved.is_file():
        raise PackageError(f"Allowlist entry must be a regular project file: {relative}")
    return candidate


def read_public_files() -> list[tuple[str, bytes]]:
    manifest = checked_source("submission-files.txt")
    entries = []
    seen = set()
    for number, raw in enumerate(manifest.read_text(encoding="utf-8-sig").splitlines(), 1):
        if not raw or raw.startswith("#"):
            continue
        if raw != raw.strip():
            raise PackageError(f"Allowlist line {number} has leading or trailing whitespace.")
        if raw.casefold() in seen:
            raise PackageError(f"Duplicate allowlist path on line {number}: {raw}")
        source = checked_source(raw)
        data = source.read_bytes()
        reject_links(source)
        entries.append((raw, data))
        seen.add(raw.casefold())
    missing = REQUIRED_FILES - {relative for relative, _ in entries}
    if missing:
        raise PackageError("Allowlist is missing required files: " + ", ".join(sorted(missing)))
    return sorted(entries)


def validate_name(value: str) -> str:
    if (not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,99}", value)
            or value.endswith(".") or value.split(".", 1)[0].upper() in WINDOWS_RESERVED):
        raise argparse.ArgumentTypeError("Use a safe 1–100 character ASCII output name.")
    return value


def build(output: Path, name: str) -> tuple[Path, Path, int, str]:
    output = output.expanduser().absolute()
    reject_links(output)
    output = output.resolve()
    if is_inside(output, PROJECT):
        raise PackageError("Output directory must be outside the original project.")
    clean = output / name
    archive = output / f"{name}.zip"
    reject_links(clean)
    reject_links(archive)
    if clean.exists() or archive.exists():
        raise PackageError("Output already exists. Keep it, and choose a new --name.")
    files = read_public_files()
    output.mkdir(parents=True, exist_ok=True)
    reject_links(output)
    # Both creations are exclusive. In an unexpected I/O failure, leave the new
    # partial output for inspection rather than deleting or replacing anything.
    clean.mkdir(exist_ok=False)
    for relative, data in files:
        destination = clean.joinpath(*PurePosixPath(relative).parts)
        if not is_inside(destination.resolve(), clean):
            raise PackageError("A destination escaped the clean output directory.")
        destination.parent.mkdir(parents=True, exist_ok=True)
        reject_links(destination)
        with destination.open("xb") as handle:
            handle.write(data)
    with zipfile.ZipFile(archive, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as bundle:
        for relative, data in files:
            member = zipfile.ZipInfo(f"{ARCHIVE_ROOT}/{relative}", date_time=(1980, 1, 1, 0, 0, 0))
            member.compress_type = zipfile.ZIP_DEFLATED
            member.create_system = 3
            member.external_attr = (stat.S_IFREG | 0o644) << 16
            bundle.writestr(member, data, compresslevel=9)
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    return clean, archive, len(files), digest


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, default=PROJECT.parent / "dist")
    parser.add_argument("--name", type=validate_name, default=DEFAULT_NAME)
    args = parser.parse_args()
    try:
        clean, archive, count, digest = build(args.output_dir, args.name)
    except (PackageError, OSError, UnicodeError, zipfile.BadZipFile) as error:
        print(f"Packaging failed: {error}", file=sys.stderr)
        return 1
    print(f"Clean directory: {clean}")
    print(f"ZIP: {archive}")
    print(f"Public files: {count}")
    print(f"SHA256: {digest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
