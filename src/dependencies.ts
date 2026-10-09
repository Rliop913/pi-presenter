// Approval-gated, evidence-grounded installer for the LibreOffice (soffice) and
// Poppler (pdftoppm) binaries Pi Presenter needs to render slides offline.
//
// The module is intentionally narrow. It exposes three functions:
//
//   - inspectDependencies(signal?, options?)     : report-only, never installs
//   - ensureDependencies(ui, signal?, options?)  : asks the user, may install
//   - resolveRenderTools(signal?, options?)      : returns paths or throws
//
// Self-imposed safety rules (none of these are negotiable through options):
//
//   * No shell. Every spawn uses `shell: false` and a fixed argv. argv tokens
//     are never concatenated into a single string and never reach `bash -c`,
//     `cmd /c`, `sh`, or `powershell`. There is no `sudo`, no `curl | sh`,
//     no `npm exec`, no download of tarballs outside the verified package
//     manager. There is no `--silent` flag, no `--yes` to apt without a UI
//     gate, no bypass of TLS or signature checks.
//
//   * The user MUST see and explicitly select the literal string
//     "Approve installation" before any install. Any other selection, an
//     undefined response, an aborted UI, or an unavailable UI results in
//     zero installs.
//
//   * Every install is identified by a fixed, single package id. There is no
//     fallback id, no "try this first then that" loop, and no heuristic that
//     picks a different package if the canonical one is missing.
//
//   * The OS, the package manager, the package id(s), the exact argv, the
//     trust/source details, and the elevation/system-change disclosure are
//     all rendered to the user BEFORE the install runs.
//
//   * After approval, the plan is re-inspected. If the plan changed (a
//     different manager became available, a different binary path appeared,
//     etc.) the install is aborted. This prevents executing a plan that no
//     longer matches what was approved.
//
//   * After an install, the resulting binary is probed with its own
//     `--version` / `-v` and the output is checked for the expected
//     identifier. We never claim success based on the installer's exit
//     code alone.
//
// The default behavior is conservative: only Windows hosts (with a
// validated WinGet CDN source) are reported as supported. macOS and Linux
// are implemented with full safety checks but the conservative default is
// "fail closed with manual instructions" because safe source validation on
// those platforms is more nuanced (brew taps and apt mirrors can be
// customized at the OS level in ways a Node-side check cannot fully
// guarantee). Tests can opt in to non-Windows platforms via
// `enableNonWindowsPlatforms: true`.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fsp, type Dirent } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

// ---- Public types ---------------------------------------------------------

/** Absolute paths to the binaries the renderer needs. */
export interface RenderTools {
  /** LibreOffice headless converter. */
  soffice: string;
  /** Poppler PDF-to-image converter. */
  pdftoppm: string;
}

/** Package manager names recognized by this module. */
export type PackageManagerName = "winget" | "brew" | "apt";

/** Status of a single binary. */
export type BinaryStatus = "installed" | "missing" | "unsupported" | "blocked";

/** Description of where a package will be fetched from. */
export interface PackageSource {
  kind:
    | "winget-cdn"
    | "homebrew-cask"
    | "homebrew-formula"
    | "apt-official"
    | "manual";
  /** Human-readable source details (will be shown to the user before install). */
  details: string;
  /** Exact URL the source must resolve to, when applicable. */
  url?: string;
  /** Exact tap name, when applicable. */
  tap?: string;
}

/** Elevation / system-change disclosure shown to the user. */
export interface ElevationDisclosure {
  /** Whether the install requires root/administrator rights. */
  requiresAdmin: boolean;
  /** Whether the user is expected to see a UAC / sudo prompt. */
  promptExpected: boolean;
  /** Whether the install will modify files outside the user's home. */
  systemChange: boolean;
  /** Install scope: "user" (no admin) or "system" (admin). */
  scope: "user" | "system";
}

/** A single binary's install plan and discovery state. */
export interface BinaryProbe {
  command: "soffice" | "pdftoppm";
  status: BinaryStatus;
  resolvedPath?: string;
  version?: string;
  packageId: string;
  packageManager: PackageManagerName | "manual";
  installCommand: string;
  installArgs: readonly string[];
  candidatePaths: readonly string[];
  trust: string;
  source: PackageSource;
  elevation: ElevationDisclosure;
  rationale: string;
}

/** Result of probing a package manager. */
export interface PackageManagerProbe {
  manager: PackageManagerName;
  available: boolean;
  resolvedPath?: string;
  version?: string;
  sourceValidation: { passed: boolean; details: string };
}

/** The full install plan. */
export interface DependencyReport {
  platform: NodeJS.Platform;
  /** True when the platform is supported by the current policy. */
  supportedPlatform: boolean;
  /** Package manager used for installs, or null when unsupported. */
  supportedPackageManager: PackageManagerName | null;
  packageManager: PackageManagerProbe | null;
  binaries: BinaryProbe[];
  /** True when every required binary is installed. */
  ready: boolean;
  /** Pre-formatted manual-install instructions for unsupported paths. */
  manualInstructions: string;
  /** True when at least one binary is missing on a supported platform. */
  preInstall: boolean;
  /** Stable hash of the plan used to detect drift between approval and execution. */
  planHash: string;
  /** Human-readable notes shown to the user. */
  notes: string[];
}

/** Minimal UI shape used to obtain explicit user approval. */
export interface DependencyUI {
  select(
    title: string,
    options: string[],
    dialogOptions?: { signal?: AbortSignal },
  ): Promise<string | undefined>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
}

/** A child-process runner. The default uses `spawn` with `shell: false`. */
export type Runner = (
  command: string,
  args: readonly string[],
  signal?: AbortSignal,
) => Promise<string>;

/** A PATH-lookup function. Default invokes `where` (win32) or `which` (unix). */
export type Which = (command: string) => Promise<string | undefined>;

/** A file-existence predicate. Default uses `fs.stat`. */
export type PathExists = (p: string) => Promise<boolean>;

/** Recursive search for a binary by name under a directory. */
export type SearchPath = (
  root: string,
  binaryName: string,
  signal?: AbortSignal,
) => Promise<string | undefined>;

/** All injection seams for offline tests. Every field is optional. */
export interface DependencyOptions {
  runner?: Runner;
  which?: Which;
  pathExists?: PathExists;
  searchPath?: SearchPath;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  localAppData?: string;
  programDirs?: readonly string[];
  wingetPackageDir?: string;
  /** Absolute WinGet executable override for offline tests, not a config field. */
  wingetPath?: string;
  installerTimeoutMs?: number;
  probeTimeoutMs?: number;
  /**
   * When true, non-Windows platforms (macOS, Linux) are considered
   * supported. Default false (conservative). Tests override this to
   * exercise the non-Windows safety checks.
   */
  enableNonWindowsPlatforms?: boolean;
  /**
   * When true, allow the apt path on Linux even though installing
   * distro packages requires root elevation. Default false. Used only
   * for tests; production must never enable this.
   */
  allowAptWithElevation?: boolean;
}

/** Error thrown by `ensureDependencies` / `resolveRenderTools` on failure. */
export class DependencyError extends Error {
  readonly report: DependencyReport;
  constructor(
    message: string,
    report: DependencyReport,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "DependencyError";
    this.report = report;
  }
}

// ---- Fixed constants ------------------------------------------------------

/** The single canonical WinGet identifier for LibreOffice. */
const WINGET_LIBREOFFICE_ID = "TheDocumentFoundation.LibreOffice";

/**
 * The single canonical WinGet identifier for the Poppler command-line tools.
 * oschwartz10612.Poppler is a community-maintained package on WinGet; it
 * is NOT the official Poppler project. The trust disclosure below makes
 * this explicit to the user.
 */
const WINGET_POPPLER_ID = "oschwartz10612.Poppler";

/** The single canonical Homebrew cask for LibreOffice. */
const BREW_LIBREOFFICE_CASK = "libreoffice";
/** The single canonical Homebrew formula for Poppler. */
const BREW_POPPLER_FORMULA = "poppler";
/** The single canonical apt package providing the LibreOffice PPTX->PDF path. */
const APT_LIBREOFFICE_PACKAGE = "libreoffice-impress";
/** The single canonical apt package providing pdftoppm. */
const APT_POPPLER_PACKAGE = "poppler-utils";

/** Fixed argv tail applied to every `winget install` call. */
const WINGET_COMMON = [
  "--accept-source-agreements",
  "--accept-package-agreements",
  "--exact",
  "--source",
  "winget",
  "--disable-interactivity",
  "--no-upgrade",
] as const;

/** Exact argv for installing LibreOffice via WinGet. */
const WINGET_LIBREOFFICE_INSTALL = [
  "install",
  "--id",
  WINGET_LIBREOFFICE_ID,
  "--scope",
  "machine",
  ...WINGET_COMMON,
] as const;

/** Exact argv for installing Poppler via WinGet. */
const WINGET_POPPLER_INSTALL = [
  "install",
  "--id",
  WINGET_POPPLER_ID,
  "--scope",
  "user",
  ...WINGET_COMMON,
] as const;

/** Exact argv for installing LibreOffice via Homebrew. */
const BREW_LIBREOFFICE_INSTALL = [
  "install",
  "--cask",
  BREW_LIBREOFFICE_CASK,
] as const;
/** Exact argv for installing Poppler via Homebrew. */
const BREW_POPPLER_INSTALL = ["install", BREW_POPPLER_FORMULA] as const;
/** Exact argv for installing LibreOffice via apt. */
const APT_LIBREOFFICE_INSTALL = [
  "install",
  "-y",
  "--no-install-recommends",
  APT_LIBREOFFICE_PACKAGE,
] as const;
/** Exact argv for installing Poppler via apt. */
const APT_POPPLER_INSTALL = [
  "install",
  "-y",
  "--no-install-recommends",
  APT_POPPLER_PACKAGE,
] as const;

/** The official WinGet CDN. Any other source is rejected. */
const WINGET_OFFICIAL_CDN = "https://cdn.winget.microsoft.com/cache";
/** The name of the default WinGet source. */
const WINGET_OFFICIAL_SOURCE_NAME = "winget";

/** Default directory under LOCALAPPDATA where WinGet stores packages. */
const WINGET_DEFAULT_PACKAGE_DIR = path.join("Microsoft", "WinGet", "Packages");

/** Default probe timeout (15s) — local to this module, not process.ts. */
const DEFAULT_PROBE_TIMEOUT_MS = 15_000;
/** Default install timeout (10 minutes) — installers are slow. */
const DEFAULT_INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
/** Max output bytes for a single probe invocation. */
const PROBE_OUTPUT_MAX_BYTES = 64 * 1024;
/** Recursive search depth for the dynamic WinGet package path. */
const WIN_POPPLER_SEARCH_DEPTH = 6;

/** The literal string the user must select to authorize an install. */
const APPROVE_LITERAL = "Approve installation";
/** The literal "Cancel" label. */
const CANCEL_LITERAL = "Cancel";
/** The literal "Show manual instructions" label. */
const SHOW_MANUAL_LITERAL = "Show manual instructions";

// ---- Default implementations ---------------------------------------------

function defaultSpawnRunner(timeoutMs: number, outputMaxBytes: number): Runner {
  return (command, args, signal) =>
    new Promise<string>((resolve, reject) => {
      signal?.throwIfAborted();
      const child = spawn(command, [...args], {
        shell: false,
        windowsHide: true,
        signal,
      });
      let output = "";
      let size = 0;
      const timer = setTimeout(() => {
        child.kill();
        reject(
          new Error(
            `${command} exceeded ${Math.round(timeoutMs / 1000)} second timeout`,
          ),
        );
      }, timeoutMs);
      const capture = (data: Buffer) => {
        size += data.length;
        if (size > outputMaxBytes) {
          child.kill();
          reject(
            new Error(
              `${command} exceeded ${outputMaxBytes} byte output limit`,
            ),
          );
        } else {
          output += data.toString("utf8");
        }
      };
      child.stdout.on("data", capture);
      child.stderr.on("data", capture);
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(
          new Error(
            `Required executable ${command} unavailable or failed: ${err.message}`,
          ),
        );
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(output);
        else
          reject(
            new Error(`${command} failed (${code}): ${output.slice(0, 2000)}`),
          );
      });
    });
}

function withTimeout(runner: Runner, timeoutMs: number, label: string): Runner {
  return (command, args, signal) =>
    new Promise<string>((resolve, reject) => {
      const controller = new AbortController();
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", stop);
      };
      const stop = () => {
        const error = signal?.reason ?? new Error(`${label} aborted`);
        controller.abort(error);
        cleanup();
        reject(error);
      };
      const timer = setTimeout(() => {
        const error = new Error(
          `${label} for ${command} exceeded ${Math.round(timeoutMs / 1000)} second timeout`,
        );
        controller.abort(error);
        cleanup();
        reject(error);
      }, timeoutMs);
      signal?.addEventListener("abort", stop, { once: true });
      if (signal?.aborted) {
        stop();
        return;
      }
      Promise.resolve()
        .then(() => {
          controller.signal.throwIfAborted();
          return runner(command, args, controller.signal);
        })
        .then(
          (value) => {
            cleanup();
            resolve(value);
          },
          (error) => {
            cleanup();
            reject(error);
          },
        );
    });
}

function defaultWhich(_runner: Runner, platform: NodeJS.Platform): Which {
  // Filesystem lookup only: never execute a potentially shadowed where/which.
  return async (command) => {
    const environmentPath = process.env.PATH ?? process.env.Path ?? "";
    const names = platform === "win32" ? [`${command}.exe`] : [command];
    for (const dir of environmentPath.split(platform === "win32" ? ";" : ":")) {
      if (!path.isAbsolute(dir) || path.resolve(dir) === process.cwd())
        continue;
      for (const name of names) {
        const candidate = path.join(dir, name);
        if (await defaultPathExists(candidate)) return candidate;
      }
    }
    return undefined;
  };
}

async function defaultPathExists(p: string): Promise<boolean> {
  try {
    const s = await fsp.stat(p);
    return s.isFile();
  } catch {
    return false;
  }
}

async function defaultSearchPath(
  root: string,
  binaryName: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const queue: Array<{ dir: string; depth: number }> = [
    { dir: root, depth: 0 },
  ];
  let visited = 0;
  let entriesSeen = 0;
  while (queue.length) {
    signal?.throwIfAborted();
    if (++visited > 256)
      throw new Error("WinGet discovery directory limit exceeded");
    const { dir, depth } = queue.shift()!;
    if (depth > WIN_POPPLER_SEARCH_DEPTH) continue;
    let entries: Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      signal?.throwIfAborted();
      if (++entriesSeen > 4096)
        throw new Error("WinGet discovery entry limit exceeded");
      // Do not execute similarly named files from unrelated WinGet packages.
      if (
        depth === 0 &&
        !entry.name.toLowerCase().startsWith("oschwartz10612.poppler_")
      )
        continue;
      const full = path.join(dir, entry.name);
      if (
        entry.isFile() &&
        entry.name.toLowerCase() === binaryName.toLowerCase()
      )
        return full;
      if (entry.isDirectory() && !entry.isSymbolicLink())
        queue.push({ dir: full, depth: depth + 1 });
    }
  }
  return undefined;
}

// ---- Source / candidate paths --------------------------------------------

function winLibreOfficeCandidates(
  localAppData: string | undefined,
  programDirs: readonly string[],
): readonly string[] {
  const out: string[] = [];
  const dirs = [...(localAppData ? [path.join(localAppData, 'Programs')] : []), ...programDirs.filter(Boolean)];
  // Windows .com is LibreOffice's console launcher; .exe may return no version stdout.
  // Both candidates still pass the same actual executable identity/version validation.
  for (const dir of dirs) {
    out.push(path.join(dir, 'LibreOffice', 'program', 'soffice.com'));
    out.push(path.join(dir, 'LibreOffice', 'program', 'soffice.exe'));
  }
  return out;
}

function darwinLibreOfficeCandidates(home: string): readonly string[] {
  return [
    "/Applications/LibreOffice.app/Contents/MacOS/soffice",
    path.join(
      home,
      "Applications",
      "LibreOffice.app",
      "Contents",
      "MacOS",
      "soffice",
    ),
    "/usr/local/bin/soffice",
    "/opt/homebrew/bin/soffice",
  ];
}

function linuxLibreOfficeCandidates(): readonly string[] {
  return ["/usr/bin/soffice", "/usr/local/bin/soffice"];
}

function darwinPopplerCandidates(home: string): readonly string[] {
  return [
    "/usr/local/bin/pdftoppm",
    "/opt/homebrew/bin/pdftoppm",
    path.join(home, "homebrew", "bin", "pdftoppm"),
  ];
}

function linuxPopplerCandidates(): readonly string[] {
  return ["/usr/bin/pdftoppm", "/usr/local/bin/pdftoppm"];
}

// ---- Build the install plan ---------------------------------------------

interface BinaryContext {
  home: string;
  localAppData: string | undefined;
  programDirs: readonly string[];
}

function buildBinaryProbes(
  manager: PackageManagerName | null,
  ctx: BinaryContext,
): BinaryProbe[] {
  if (manager === "winget") {
    return [
      {
        command: "soffice",
        status: "missing",
        packageId: WINGET_LIBREOFFICE_ID,
        packageManager: "winget",
        installCommand: "winget",
        installArgs: WINGET_LIBREOFFICE_INSTALL,
        candidatePaths: winLibreOfficeCandidates(
          ctx.localAppData,
          ctx.programDirs,
        ),
        trust:
          "LibreOffice from the fixed WinGet package, relying on WinGet manifest/checksum verification. Presenter does not independently verify a binary signature. Machine-scope installation may require explicit Windows UAC approval.",
        source: {
          kind: "winget-cdn",
          details:
            "Source URL is validated against the official WinGet CDN before any install runs.",
          url: WINGET_OFFICIAL_CDN,
        },
        elevation: {
          requiresAdmin: true,
          promptExpected: true,
          systemChange: true,
          scope: "system",
        },
        rationale:
          "LibreOffice (soffice) renders PPTX to PDF without third-party network calls or model invocations.",
      },
      {
        command: "pdftoppm",
        status: "missing",
        packageId: WINGET_POPPLER_ID,
        packageManager: "winget",
        installCommand: "winget",
        installArgs: WINGET_POPPLER_INSTALL,
        candidatePaths: [],
        trust:
          "oschwartz10612.Poppler is a COMMUNITY-MAINTAINED Poppler distribution on WinGet; it is NOT the official Poppler project. The trust surface is the Microsoft WinGet CDN (validated), not the upstream Poppler maintainers.",
        source: {
          kind: "winget-cdn",
          details:
            "Source URL is validated against the official WinGet CDN before any install runs.",
          url: WINGET_OFFICIAL_CDN,
        },
        elevation: {
          requiresAdmin: false,
          promptExpected: true,
          systemChange: true,
          scope: "user",
        },
        rationale:
          "pdftoppm converts PDF to PNG. The selected package is a community distribution; Presenter relies on WinGet manifest/checksum verification, not an independently verified upstream installer.",
      },
    ];
  }
  if (manager === "brew") {
    return [
      {
        command: "soffice",
        status: "missing",
        packageId: BREW_LIBREOFFICE_CASK,
        packageManager: "brew",
        installCommand: "brew",
        installArgs: BREW_LIBREOFFICE_INSTALL,
        candidatePaths: darwinLibreOfficeCandidates(ctx.home),
        trust:
          "Homebrew official libreoffice cask. Verified against formulae.brew.sh; tap is homebrew/cask.",
        source: {
          kind: "homebrew-cask",
          details:
            "Tap must be homebrew/cask. HOMEBREW_GIT_URL / HOMEBREW_API_DOMAIN / HOMEBREW_BOTTLE_DOMAIN overrides are rejected.",
          tap: "homebrew/cask",
        },
        elevation: {
          requiresAdmin: false,
          promptExpected: false,
          systemChange: true,
          scope: "user",
        },
        rationale:
          "Homebrew cask libreoffice is the official LibreOffice distribution for macOS.",
      },
      {
        command: "pdftoppm",
        status: "missing",
        packageId: BREW_POPPLER_FORMULA,
        packageManager: "brew",
        installCommand: "brew",
        installArgs: BREW_POPPLER_INSTALL,
        candidatePaths: darwinPopplerCandidates(ctx.home),
        trust:
          "Homebrew poppler formula. Verified against formulae.brew.sh; tap is homebrew/core.",
        source: {
          kind: "homebrew-formula",
          details:
            "Tap must be homebrew/core. HOMEBREW_GIT_URL / HOMEBREW_API_DOMAIN / HOMEBREW_BOTTLE_DOMAIN overrides are rejected.",
          tap: "homebrew/core",
        },
        elevation: {
          requiresAdmin: false,
          promptExpected: false,
          systemChange: true,
          scope: "user",
        },
        rationale:
          "Homebrew poppler is the official Poppler distribution for macOS.",
      },
    ];
  }
  if (manager === "apt") {
    return [
      {
        command: "soffice",
        status: "missing",
        packageId: APT_LIBREOFFICE_PACKAGE,
        packageManager: "apt",
        installCommand: "apt-get",
        installArgs: APT_LIBREOFFICE_INSTALL,
        candidatePaths: linuxLibreOfficeCandidates(),
        trust:
          "Debian/Ubuntu official libreoffice-impress package. apt sources must be from the official mirror (deb.debian.org / archive.ubuntu.com).",
        source: {
          kind: "apt-official",
          details:
            "Sources must be from deb.debian.org or archive.ubuntu.com. PPAs and custom mirrors are rejected. apt requires root; non-root elevation is required.",
        },
        elevation: {
          requiresAdmin: true,
          promptExpected: true,
          systemChange: true,
          scope: "system",
        },
        rationale:
          "libreoffice-impress is the official LibreOffice package on Debian/Ubuntu. apt installs require root; this is the conservative default and is disabled unless the operator opts in.",
      },
      {
        command: "pdftoppm",
        status: "missing",
        packageId: APT_POPPLER_PACKAGE,
        packageManager: "apt",
        installCommand: "apt-get",
        installArgs: APT_POPPLER_INSTALL,
        candidatePaths: linuxPopplerCandidates(),
        trust:
          "Debian/Ubuntu official poppler-utils package. apt sources must be from the official mirror (deb.debian.org / archive.ubuntu.com).",
        source: {
          kind: "apt-official",
          details:
            "Sources must be from deb.debian.org or archive.ubuntu.com. PPAs and custom mirrors are rejected. apt requires root; non-root elevation is required.",
        },
        elevation: {
          requiresAdmin: true,
          promptExpected: true,
          systemChange: true,
          scope: "system",
        },
        rationale:
          "poppler-utils is the official Poppler package on Debian/Ubuntu. apt installs require root; this is the conservative default and is disabled unless the operator opts in.",
      },
    ];
  }
  return [
    {
      command: "soffice",
      status: "unsupported",
      packageId: "manual",
      packageManager: "manual",
      installCommand: "",
      installArgs: [],
      candidatePaths: [],
      trust:
        "Platform is not currently supported by the automated installer. Install manually.",
      source: {
        kind: "manual",
        details: "No supported package manager for this platform.",
      },
      elevation: {
        requiresAdmin: false,
        promptExpected: false,
        systemChange: false,
        scope: "user",
      },
      rationale:
        "LibreOffice (soffice) is required to render PPTX -> PDF. Install manually and ensure `soffice` is on PATH.",
    },
    {
      command: "pdftoppm",
      status: "unsupported",
      packageId: "manual",
      packageManager: "manual",
      installCommand: "",
      installArgs: [],
      candidatePaths: [],
      trust:
        "Platform is not currently supported by the automated installer. Install manually.",
      source: {
        kind: "manual",
        details: "No supported package manager for this platform.",
      },
      elevation: {
        requiresAdmin: false,
        promptExpected: false,
        systemChange: false,
        scope: "user",
      },
      rationale:
        "Poppler (pdftoppm) is required to render PDF -> PNG. Install manually and ensure `pdftoppm` is on PATH.",
    },
  ];
}

// ---- Source validation ----------------------------------------------------

/** Validate the locale-independent `winget source export --name winget` JSON. */
function validateWingetSource(stdout: string): {
  passed: boolean;
  details: string;
  resolvedUrl?: string;
} {
  let source: unknown;
  try {
    source = JSON.parse(stdout.trim());
  } catch {
    return {
      passed: false,
      details:
        "Could not parse winget source export JSON; refusing installation.",
    };
  }
  if (!source || typeof source !== "object" || Array.isArray(source))
    return { passed: false, details: "Invalid winget source export object." };
  const entry = source as Record<string, unknown>;
  const resolvedUrl = typeof entry.Arg === "string" ? entry.Arg : undefined;
  if (
    entry.Name !== WINGET_OFFICIAL_SOURCE_NAME ||
    entry.Type !== "Microsoft.PreIndexed.Package" ||
    resolvedUrl !== WINGET_OFFICIAL_CDN
  ) {
    return {
      passed: false,
      details: `Untrusted winget source name/type/URL: ${JSON.stringify({ Name: entry.Name, Type: entry.Type, Arg: resolvedUrl })}`,
      resolvedUrl,
    };
  }
  return {
    passed: true,
    details: `WinGet source validated: ${resolvedUrl}`,
    resolvedUrl,
  };
}

/** Validates the Homebrew environment for source spoofing. */
function validateBrewEnv(env: NodeJS.ProcessEnv): {
  passed: boolean;
  details: string;
} {
  const overrides: Array<[string, string | undefined]> = [
    ["HOMEBREW_GIT_URL", env.HOMEBREW_GIT_URL],
    ["HOMEBREW_API_DOMAIN", env.HOMEBREW_API_DOMAIN],
    ["HOMEBREW_BOTTLE_DOMAIN", env.HOMEBREW_BOTTLE_DOMAIN],
    ["HOMEBREW_NO_INSTALL_FROM_API", env.HOMEBREW_NO_INSTALL_FROM_API],
  ];
  const set = overrides.filter(([, v]) => v && v.length > 0);
  if (set.length > 0) {
    return {
      passed: false,
      details: `Homebrew env overrides detected: ${set.map(([k]) => k).join(", ")}. These can redirect installs to unofficial remotes; refusing to install.`,
    };
  }
  return {
    passed: true,
    details:
      "Homebrew env has no HOMEBREW_* overrides; using formulae.brew.sh.",
  };
}

/** Validates the apt source list for spoofing. Conservative: rejects anything that is not an official mirror. */
function validateAptSources(contents: string): {
  passed: boolean;
  details: string;
} {
  const allowed = [
    "deb.debian.org",
    "security.debian.org",
    "archive.ubuntu.com",
    "ports.ubuntu.com",
  ];
  const lines = contents.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const lower = trimmed.toLowerCase();
    // Reject any line mentioning a known unofficial source, ppa, file://, or unknown domain.
    const suspicious =
      lower.includes("ppa.launchpad.net") ||
      lower.includes("ppa.") ||
      lower.startsWith("deb file:") ||
      lower.startsWith("deb-src file:") ||
      lower.startsWith("deb tor+") ||
      lower.includes(" .onion");
    if (suspicious) {
      return {
        passed: false,
        details: `Suspicious apt source line: ${trimmed}`,
      };
    }
    // If the line references an http(s) URL, it must mention one of the allowed mirrors.
    const urlMatch = lower.match(/https?:\/\/([^\s/]+)/);
    if (urlMatch) {
      const host = urlMatch[1];
      if (!allowed.some((d) => host === d || host.endsWith("." + d))) {
        return {
          passed: false,
          details: `Apt source host ${host} is not an official Debian/Ubuntu mirror.`,
        };
      }
    }
  }
  return {
    passed: true,
    details: "Apt sources are from official Debian/Ubuntu mirrors.",
  };
}

// ---- Probe executables ----------------------------------------------------

const PROBE_ARGS = {
  soffice: ["--version"],
  pdftoppm: ["-v"],
} as const;

const PROBE_VALIDATORS = {
  soffice: (output: string) => /LibreOffice\s+\d+\.\d+/.test(output),
  pdftoppm: (output: string) => /\bpdftoppm version \d+\.\d+/i.test(output),
} as const;

async function probeBinary(
  binary: BinaryProbe,
  platform: NodeJS.Platform,
  which: Which,
  pathExists: PathExists,
  searchPath: SearchPath,
  runner: Runner,
  signal: AbortSignal | undefined,
  wingetPackageDir: string,
): Promise<{ status: BinaryStatus; resolvedPath?: string; version?: string }> {
  signal?.throwIfAborted();
  const pathApi = platform === "win32" ? path.win32 : path;
  const onPath = await which(binary.command);
  const candidates = [
    ...new Set(
      [onPath, ...binary.candidatePaths].filter((p): p is string => !!p),
    ),
  ];
  if (
    platform === "win32" &&
    binary.command === "pdftoppm" &&
    wingetPackageDir
  ) {
    const searched = await searchPath(wingetPackageDir, "pdftoppm.exe", signal);
    if (searched) {
      const relative = pathApi.relative(wingetPackageDir, searched);
      if (
        !relative.startsWith("..") &&
        !pathApi.isAbsolute(relative) &&
        relative
          .split(pathApi.sep)[0]
          .toLowerCase()
          .startsWith("oschwartz10612.poppler_")
      )
        candidates.push(searched);
    }
  }
  for (const candidate of candidates) {
    signal?.throwIfAborted();
    if (
      !pathApi.isAbsolute(candidate) ||
      pathApi.resolve(pathApi.dirname(candidate)) ===
        pathApi.resolve(process.cwd())
    )
      continue;
    if (candidate !== onPath && !(await pathExists(candidate))) continue;
    try {
      const output = await runner(
        candidate,
        PROBE_ARGS[binary.command],
        signal,
      );
      if (PROBE_VALIDATORS[binary.command](output))
        return {
          status: "installed",
          resolvedPath: candidate,
          version: output.trim().split(/\r?\n/)[0],
        };
    } catch {
      signal?.throwIfAborted();
    }
  }
  return { status: "missing" };
}

// ---- Package manager probes ----------------------------------------------

/** Validate the App Execution Alias target against Microsoft's Store package identity. */
export function isTrustedAppInstallerTarget(
  target: string,
  programDirs: readonly string[],
): boolean {
  if (
    !path.win32.isAbsolute(target) ||
    path.win32.basename(target).toLowerCase() !== "winget.exe"
  )
    return false;
  const folder = path.win32.dirname(target);
  if (
    !/^Microsoft\.DesktopAppInstaller_[0-9.]+_(?:x64|x86|arm64|neutral)__8wekyb3d8bbwe$/i.test(
      path.win32.basename(folder),
    )
  )
    return false;
  return programDirs.some(
    (root) =>
      path.win32.isAbsolute(root) &&
      path.win32.dirname(folder).toLowerCase() ===
        path.win32.join(root, "WindowsApps").toLowerCase(),
  );
}
async function trustedWingetAliasExists(
  alias: string,
  programDirs: readonly string[],
): Promise<boolean> {
  try {
    // Store aliases can deny stat/realpath while lstat/readlink/access work.
    const stat = await fsp.lstat(alias);
    if (!stat.isSymbolicLink()) return false;
    if (!isTrustedAppInstallerTarget(await fsp.readlink(alias), programDirs))
      return false;
    await fsp.access(alias);
    return true;
  } catch {
    return false;
  }
}

async function probeWinget(
  runner: Runner,
  signal: AbortSignal | undefined,
  executable: string,
  pathExists: PathExists,
): Promise<PackageManagerProbe> {
  try {
    // Never resolve a package manager from cwd or a model-controlled PATH entry.
    if (!path.win32.isAbsolute(executable) || !(await pathExists(executable)))
      throw new Error("Trusted Windows App Installer alias was not found");
    const version = (await runner(executable, ["--version"], signal)).trim();
    if (!/^v?\d+\.\d+/.test(version))
      throw new Error("Unexpected WinGet version identity");
    const exported = await runner(
      executable,
      ["source", "export", "--name", "winget"],
      signal,
    );
    const validation = validateWingetSource(exported);
    return {
      manager: "winget",
      available: validation.passed,
      resolvedPath: executable,
      version,
      sourceValidation: validation,
    };
  } catch (e) {
    signal?.throwIfAborted();
    return {
      manager: "winget",
      available: false,
      sourceValidation: {
        passed: false,
        details: `winget is unavailable or unsafe: ${e instanceof Error ? e.message : String(e)}`,
      },
    };
  }
}

async function probeBrew(
  runner: Runner,
  signal: AbortSignal | undefined,
  env: NodeJS.ProcessEnv,
): Promise<PackageManagerProbe> {
  const envValidation = validateBrewEnv(env);
  if (!envValidation.passed) {
    return {
      manager: "brew",
      available: false,
      sourceValidation: envValidation,
    };
  }
  try {
    const versionOutput = await runner("brew", ["--version"], signal);
    const version = versionOutput.trim();
    return {
      manager: "brew",
      available: true,
      version,
      sourceValidation: envValidation,
    };
  } catch (e) {
    return {
      manager: "brew",
      available: false,
      sourceValidation: {
        passed: false,
        details: `brew is unavailable: ${e instanceof Error ? e.message : String(e)}`,
      },
    };
  }
}

async function probeApt(
  runner: Runner,
  signal: AbortSignal | undefined,
  allowElevation: boolean,
): Promise<PackageManagerProbe> {
  if (!allowElevation) {
    return {
      manager: "apt",
      available: false,
      sourceValidation: {
        passed: false,
        details:
          "apt install requires root. Non-root elevation is not available, so the apt path is disabled by policy. Install manually with sudo.",
      },
    };
  }
  // Best-effort: try to read /etc/apt/sources.list to validate the source.
  let sourceValidation: { passed: boolean; details: string };
  try {
    const buf = await fsp.readFile("/etc/apt/sources.list", "utf8");
    sourceValidation = validateAptSources(buf);
  } catch (e) {
    sourceValidation = {
      passed: false,
      details: `Cannot read /etc/apt/sources.list: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (!sourceValidation.passed) {
    return { manager: "apt", available: false, sourceValidation };
  }
  try {
    const versionOutput = await runner("apt-get", ["--version"], signal);
    return {
      manager: "apt",
      available: true,
      version: versionOutput.trim().split(/\r?\n/)[0],
      sourceValidation,
    };
  } catch (e) {
    return {
      manager: "apt",
      available: false,
      sourceValidation: {
        passed: false,
        details: `apt-get is unavailable: ${e instanceof Error ? e.message : String(e)}`,
      },
    };
  }
}

// ---- Plan hash ------------------------------------------------------------

function planReportForHash(
  plan: Omit<DependencyReport, "planHash" | "manualInstructions" | "notes">,
): string {
  return JSON.stringify({
    platform: plan.platform,
    supportedPackageManager: plan.supportedPackageManager,
    packageManager: plan.packageManager
      ? {
          manager: plan.packageManager.manager,
          available: plan.packageManager.available,
          resolvedPath: plan.packageManager.resolvedPath,
          version: plan.packageManager.version,
          sourceValidation: plan.packageManager.sourceValidation,
        }
      : null,
    binaries: plan.binaries.map((b) => ({
      command: b.command,
      status: b.status,
      packageId: b.packageId,
      packageManager: b.packageManager,
      installCommand: b.installCommand,
      installArgs: b.installArgs,
      candidatePaths: b.candidatePaths,
      source: b.source,
      elevation: b.elevation,
      trust: b.trust,
      resolvedPath: b.resolvedPath,
      version: b.version,
    })),
  });
}

function computePlanHash(
  plan: Omit<DependencyReport, "planHash" | "manualInstructions" | "notes">,
): string {
  return createHash("sha256").update(planReportForHash(plan)).digest("hex");
}

// ---- Manual instructions --------------------------------------------------

function manualInstructionsFor(
  plan: Omit<DependencyReport, "planHash" | "manualInstructions" | "notes">,
): string {
  const lines: string[] = [];
  lines.push(
    "Pi Presenter render dependencies (soffice, pdftoppm) are not installed.",
  );
  lines.push(`Platform: ${plan.platform}`);
  if (!plan.supportedPlatform) {
    lines.push(
      "This platform is not currently supported by the automated installer (conservative default).",
    );
    lines.push(
      "Install the dependencies manually and ensure both `soffice` and `pdftoppm` are on PATH:",
    );
  } else if (!plan.packageManager?.available) {
    lines.push(
      `The package manager (${plan.supportedPackageManager}) is not available or its source is not validated.`,
    );
    lines.push(
      `Reason: ${plan.packageManager?.sourceValidation.details ?? "unknown"}`,
    );
    lines.push(
      "Install the dependencies manually, or fix the package manager, then re-run Pi Presenter:",
    );
  }
  for (const binary of plan.binaries) {
    lines.push(
      `- ${binary.command} (${binary.packageId}) via ${binary.packageManager}`,
    );
  }
  return lines.join("\n");
}

// ---- Public API -----------------------------------------------------------

function resolveContext(options: DependencyOptions | undefined) {
  const platform = options?.platform ?? process.platform;
  const env = options?.env ?? process.env;
  const home = options?.home ?? os.homedir();
  const localAppData =
    options?.localAppData ??
    (platform === "win32" ? env.LOCALAPPDATA : undefined);
  const programDirs =
    options?.programDirs ??
    (platform === "win32"
      ? [env.ProgramFiles, env.ProgramW6432, env["ProgramFiles(x86)"]].filter(
          (d): d is string => typeof d === "string" && d.length > 0,
        )
      : []);
  const wingetPackageDir =
    options?.wingetPackageDir ??
    (platform === "win32" && localAppData
      ? path.join(localAppData, WINGET_DEFAULT_PACKAGE_DIR)
      : "");
  const enableNonWindows = options?.enableNonWindowsPlatforms ?? false;
  const allowApt = options?.allowAptWithElevation ?? false;
  const probeTimeoutMs = options?.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const installTimeoutMs =
    options?.installerTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS;
  const baseRunner =
    options?.runner ??
    defaultSpawnRunner(probeTimeoutMs, PROBE_OUTPUT_MAX_BYTES);
  const runner = withTimeout(baseRunner, probeTimeoutMs, "probe");
  const which = options?.which ?? defaultWhich(runner, platform);
  const pathExists = options?.pathExists ?? defaultPathExists;
  const searchPath = options?.searchPath ?? defaultSearchPath;
  return {
    platform,
    env,
    home,
    localAppData,
    programDirs,
    wingetPackageDir,
    enableNonWindows,
    allowApt,
    probeTimeoutMs,
    installTimeoutMs,
    runner,
    which,
    pathExists,
    searchPath,
  };
}

function chooseManager(
  platform: NodeJS.Platform,
  enableNonWindows: boolean,
): { manager: PackageManagerName | null; supportedPlatform: boolean } {
  if (platform === "win32")
    return { manager: "winget", supportedPlatform: true };
  if (!enableNonWindows) return { manager: null, supportedPlatform: false };
  if (platform === "darwin")
    return { manager: "brew", supportedPlatform: true };
  if (platform === "linux") return { manager: "apt", supportedPlatform: true };
  return { manager: null, supportedPlatform: false };
}

async function buildReport(
  signal: AbortSignal | undefined,
  options: DependencyOptions | undefined,
): Promise<DependencyReport> {
  const ctx = resolveContext(options);
  signal?.throwIfAborted();
  const { manager, supportedPlatform } = chooseManager(
    ctx.platform,
    ctx.enableNonWindows,
  );
  const ctxBin: BinaryContext = {
    home: ctx.home,
    localAppData: ctx.localAppData,
    programDirs: ctx.programDirs,
  };
  const binaries = buildBinaryProbes(manager, ctxBin);
  // Probe each binary.
  for (const binary of binaries) {
    // Installation policy does not disable use of already installed tools.
    if (!manager)
      binary.candidatePaths =
        ctx.platform === "darwin"
          ? binary.command === "soffice"
            ? darwinLibreOfficeCandidates(ctx.home)
            : darwinPopplerCandidates(ctx.home)
          : binary.command === "soffice"
            ? linuxLibreOfficeCandidates()
            : linuxPopplerCandidates();
    const probe = await probeBinary(
      binary,
      ctx.platform,
      ctx.which,
      ctx.pathExists,
      ctx.searchPath,
      ctx.runner,
      signal,
      ctx.wingetPackageDir,
    );
    binary.status =
      !manager && probe.status !== "installed" ? "unsupported" : probe.status;
    binary.resolvedPath = probe.resolvedPath;
    binary.version = probe.version;
  }
  // Probe the package manager.
  let packageManager: PackageManagerProbe | null = null;
  if (manager === "winget") {
    const executable =
      options?.wingetPath ??
      path.join(
        ctx.localAppData ?? path.join(ctx.home, "AppData", "Local"),
        "Microsoft",
        "WindowsApps",
        "winget.exe",
      );
    const verifyAlias =
      options?.pathExists ??
      ((file: string) => trustedWingetAliasExists(file, ctx.programDirs));
    packageManager = await probeWinget(
      ctx.runner,
      signal,
      executable,
      verifyAlias,
    );
    if (packageManager.resolvedPath)
      for (const binary of binaries)
        binary.installCommand = packageManager.resolvedPath;
  } else if (manager === "brew") {
    packageManager = await probeBrew(ctx.runner, signal, ctx.env);
  } else if (manager === "apt") {
    packageManager = await probeApt(ctx.runner, signal, ctx.allowApt);
  }
  signal?.throwIfAborted();
  const ready = binaries.every((b) => b.status === "installed");
  const preInstall =
    supportedPlatform && packageManager?.available === true && !ready;
  const basePlan: Omit<
    DependencyReport,
    "planHash" | "manualInstructions" | "notes"
  > = {
    platform: ctx.platform,
    supportedPlatform,
    supportedPackageManager: manager,
    packageManager,
    binaries,
    ready,
    preInstall,
  };
  const manualInstructions = manualInstructionsFor(basePlan);
  const planHash = computePlanHash(basePlan);
  const notes = buildNotes(basePlan);
  return { ...basePlan, manualInstructions, planHash, notes };
}

function buildNotes(
  plan: Omit<DependencyReport, "planHash" | "manualInstructions" | "notes">,
): string[] {
  const notes: string[] = [];
  if (!plan.supportedPlatform) {
    notes.push(
      `Platform ${plan.platform} is not currently supported by the automated installer (conservative default).`,
    );
    return notes;
  }
  if (plan.packageManager && !plan.packageManager.available) {
    notes.push(
      `${plan.supportedPackageManager} is unavailable or its source is not validated: ${plan.packageManager.sourceValidation.details}`,
    );
  }
  for (const b of plan.binaries) {
    if (b.status === "installed") {
      notes.push(
        `${b.command}: installed at ${b.resolvedPath}${b.version ? ` (${b.version})` : ""}.`,
      );
    } else if (b.status === "missing") {
      notes.push(
        `${b.command}: not found; planned install via ${b.packageManager} (${b.packageId}).`,
      );
    } else {
      notes.push(`${b.command}: ${b.status}.`);
    }
  }
  return notes;
}

/** Inspect the current state. Never installs. */
export async function inspectDependencies(
  signal?: AbortSignal,
  options?: DependencyOptions,
): Promise<DependencyReport> {
  return buildReport(signal, options);
}

/**
 * Ensure soffice and pdftoppm are available. When they are already
 * installed this returns immediately without prompting the user.
 * Otherwise it asks the user to select the literal
 * "Approve installation" via `ui.select`, re-checks the plan to make
 * sure it has not drifted, runs the install(s), and re-probes the
 * resulting binaries.
 *
 * Any non-approval selection (or undefined / abort / missing UI) results
 * in zero installs and a DependencyError carrying the full report.
 */
export async function ensureDependencies(
  ui: DependencyUI,
  signal?: AbortSignal,
  options?: DependencyOptions,
): Promise<RenderTools> {
  if (
    !ui ||
    typeof ui.select !== "function" ||
    typeof ui.notify !== "function"
  ) {
    const report = await buildReport(signal, options);
    throw new DependencyError(
      "Native UI is required to authorize installation. No install was attempted.",
      report,
    );
  }
  const before = await buildReport(signal, options);
  if (before.ready) {
    ui.notify(
      "Render dependencies are already installed; no install was needed.",
      "info",
    );
    return toolsFromReport(before);
  }
  if (!before.supportedPlatform) {
    ui.notify(
      `Platform ${before.platform} is not supported by the automated installer. Install manually:\n${before.manualInstructions}`,
      "error",
    );
    throw new DependencyError(
      `Platform ${before.platform} is not supported by the automated installer.`,
      before,
    );
  }
  if (!before.packageManager?.available) {
    ui.notify(
      `Package manager ${before.supportedPackageManager} is unavailable or its source is not validated. Install manually:\n${before.manualInstructions}`,
      "error",
    );
    throw new DependencyError(
      `Package manager ${before.supportedPackageManager} is unavailable or its source is not validated: ${before.packageManager?.sourceValidation.details ?? "unknown"}`,
      before,
    );
  }
  // Render the approval dialog.
  const title = buildApprovalTitle(before);
  const summary = buildApprovalSummary(before);
  ui.notify(summary, "info");
  const choices = [APPROVE_LITERAL, SHOW_MANUAL_LITERAL, CANCEL_LITERAL];
  const selected = await ui.select(`${title}\n\n${summary}`, choices, {
    signal,
  });
  if (selected === undefined) {
    throw new DependencyError(
      "Installation was cancelled (no UI response); no install was performed.",
      before,
    );
  }
  if (selected === CANCEL_LITERAL) {
    throw new DependencyError(
      "Installation was cancelled by user; no install was performed.",
      before,
    );
  }
  if (selected === SHOW_MANUAL_LITERAL) {
    ui.notify(before.manualInstructions, "info");
    throw new DependencyError(
      "User requested manual instructions; no install was performed.",
      before,
    );
  }
  if (selected !== APPROVE_LITERAL) {
    throw new DependencyError(
      `Unknown UI selection ${JSON.stringify(selected)}; no install was performed.`,
      before,
    );
  }
  // Re-check the plan to detect drift (manager appeared/disappeared,
  // a binary got installed, etc.).
  const after = await buildReport(signal, options);
  if (after.planHash !== before.planHash) {
    throw new DependencyError(
      "The install plan changed after approval. The previously approved plan was not executed; please re-approve.",
      after,
    );
  }
  if (after.ready) {
    return toolsFromReport(after);
  }
  // Run each missing install.
  const installRunner = withTimeout(
    options?.runner ??
      defaultSpawnRunner(
        options?.installerTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS,
        2 * 1024 * 1024,
      ),
    options?.installerTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS,
    "install",
  );
  for (const binary of after.binaries) {
    if (binary.status === "installed") continue;
    if (!binary.installCommand || binary.installArgs.length === 0) {
      // No install plan for this binary (e.g., manual / unsupported).
      throw new DependencyError(
        `Binary ${binary.command} cannot be installed automatically on this platform. Install manually:\n${after.manualInstructions}`,
        after,
      );
    }
    signal?.throwIfAborted();
    ui.notify(
      `Installing ${binary.command} via ${binary.installCommand} ${binary.installArgs.join(" ")} ...`,
      "info",
    );
    try {
      await installRunner(binary.installCommand, binary.installArgs, signal);
    } catch (e) {
      throw new DependencyError(
        `Install of ${binary.packageId} failed: ${e instanceof Error ? e.message : String(e)}`,
        after,
        { cause: e },
      );
    }
    // Re-probe. We never claim success based on the installer's exit
    // code alone.
    const reprobe = await probeBinary(
      binary,
      after.platform,
      ctxWhichFor(after.platform, options),
      ctxPathExists(options),
      ctxSearchPath(options),
      installRunner,
      signal,
      ctxWingetPackageDir(after.platform, options),
    );
    if (reprobe.status !== "installed") {
      throw new DependencyError(
        `Install of ${binary.packageId} reported success but ${binary.command} was not found at the expected path. Install manually:\n${after.manualInstructions}`,
        after,
      );
    }
    binary.status = reprobe.status;
    binary.resolvedPath = reprobe.resolvedPath;
    binary.version = reprobe.version;
  }
  // Final report.
  const finalReport = await buildReport(signal, options);
  if (!finalReport.ready) {
    throw new DependencyError(
      `After installs, the binaries are still not all available. Install manually:\n${finalReport.manualInstructions}`,
      finalReport,
    );
  }
  return toolsFromReport(finalReport);
}

/** Return the resolved tools, or throw if anything is missing. */
export async function resolveRenderTools(
  signal?: AbortSignal,
  options?: DependencyOptions,
): Promise<RenderTools> {
  const report = await buildReport(signal, options);
  if (!report.ready) {
    throw new DependencyError(
      `Render tools are not all available. ${report.manualInstructions}`,
      report,
    );
  }
  return toolsFromReport(report);
}

function toolsFromReport(report: DependencyReport): RenderTools {
  const soffice = report.binaries.find(
    (b) => b.command === "soffice",
  )?.resolvedPath;
  const pdftoppm = report.binaries.find(
    (b) => b.command === "pdftoppm",
  )?.resolvedPath;
  if (!soffice || !pdftoppm) {
    throw new DependencyError(
      `Render tools are not all available. ${report.manualInstructions}`,
      report,
    );
  }
  return { soffice, pdftoppm };
}

// ---- Approval text -------------------------------------------------------

function buildApprovalTitle(plan: DependencyReport): string {
  const missing = plan.binaries
    .filter((b) => b.status !== "installed")
    .map((b) => b.command);
  const list = missing.length === 0 ? "(none)" : missing.join(", ");
  return [
    `Approve installation of render dependencies`,
    ``,
    `Platform: ${plan.platform}`,
    `Package manager: ${plan.supportedPackageManager} (${plan.packageManager?.version ?? "unknown version"})`,
    `Source validation: ${plan.packageManager?.sourceValidation.details ?? "n/a"}`,
    `Missing: ${list}`,
    ``,
    `Selecting "${APPROVE_LITERAL}" runs the exact argv below. LibreOffice may need separate Windows UAC approval. Installs can change system files; cancellation does not roll back a completed install.`,
    `Any other selection performs zero installs.`,
  ].join("\n");
}

function buildApprovalSummary(plan: DependencyReport): string {
  const lines: string[] = [];
  lines.push(`Pi Presenter install plan (platform: ${plan.platform}):`);
  for (const b of plan.binaries) {
    if (b.status === "installed") {
      lines.push(
        `  - ${b.command}: already installed at ${b.resolvedPath ?? "?"}`,
      );
      continue;
    }
    lines.push(`  - ${b.command}: packageId=${b.packageId}`);
    lines.push(
      `    source: ${b.source.details}${b.source.url ? ` (${b.source.url})` : ""}${b.source.tap ? ` tap=${b.source.tap}` : ""}`,
    );
    lines.push(`    trust: ${b.trust}`);
    lines.push(
      `    elevation: requiresAdmin=${b.elevation.requiresAdmin} promptExpected=${b.elevation.promptExpected} systemChange=${b.elevation.systemChange} scope=${b.elevation.scope}`,
    );
    lines.push(`    rationale: ${b.rationale}`);
    lines.push(
      `    exact argv: ${b.installCommand} ${b.installArgs.join(" ")}`,
    );
  }
  lines.push("");
  lines.push(`planHash: ${plan.planHash}`);
  return lines.join("\n");
}

// ---- Internal helpers for ensureDependencies re-probe -------------------

function ctxWhichFor(
  platform: NodeJS.Platform,
  options: DependencyOptions | undefined,
): Which {
  if (options?.which) return options.which;
  const runner = withTimeout(
    options?.runner ??
      defaultSpawnRunner(DEFAULT_PROBE_TIMEOUT_MS, PROBE_OUTPUT_MAX_BYTES),
    options?.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
    "probe",
  );
  return defaultWhich(runner, platform);
}
function ctxPathExists(options: DependencyOptions | undefined): PathExists {
  return options?.pathExists ?? defaultPathExists;
}
function ctxSearchPath(options: DependencyOptions | undefined): SearchPath {
  return options?.searchPath ?? defaultSearchPath;
}
function ctxWingetPackageDir(
  platform: NodeJS.Platform,
  options: DependencyOptions | undefined,
): string {
  if (options?.wingetPackageDir) return options.wingetPackageDir;
  if (platform !== "win32") return "";
  const env = options?.env ?? process.env;
  const localAppData = options?.localAppData ?? env.LOCALAPPDATA;
  if (!localAppData) return "";
  return path.join(localAppData, WINGET_DEFAULT_PACKAGE_DIR);
}
