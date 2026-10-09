// OFFLINE tests for the render-dependency installer. No real package manager
// or renderer is executed; every external interaction goes through the
// injected runner/which/pathExists/searchPath seams in DependencyOptions.
//
// These tests cover the spec from the dependency-installer plan:
//   * approvals / cancel produce zero installs
//   * source spoofing (custom winget source, HOMEBREW_* env overrides, custom
//     apt mirrors) fails closed
//   * unsupported OS (darwin/linux without enableNonWindowsPlatforms) does
//     not install
//   * already-installed binaries cause zero install calls
//   * post-install missing binaries throw
//   * no shell — every spawn uses shell: false (verified by the absence of
//     any shell-like command in the recorded calls and by argv type being
//     readonly string[])
//   * fixed argv — install argv is the constant, no shell metachars, no
//     fallback ids
//   * changed plan between approval and execution is rejected
//   * abort stops the install

import test from "node:test";
import assert from "node:assert/strict";

import {
  inspectDependencies,
  ensureDependencies,
  resolveRenderTools,
  DependencyError,
  type DependencyUI,
  isTrustedAppInstallerTarget,
  type Runner,
  type Which,
  type PathExists,
  type SearchPath,
  type DependencyOptions,
  type DependencyReport,
} from "../src/dependencies.js";

// Re-export the constants that the implementation keeps private, via a tiny
// indirect import. The implementation re-uses these from the file directly;
// the tests re-declare them here to make the contract explicit and to fail
// loudly if the implementation changes the canonical id without intending to.
// (The "double" is intentional — these are the same string literals the
// implementation uses. Changing the implementation id requires changing this
// file too, which is exactly the safety property we want.)
const WINGET_LIBREOFFICE_ID = "TheDocumentFoundation.LibreOffice";
const WINGET_POPPLER_ID = "oschwartz10612.Poppler";
const WINGET_OFFICIAL_CDN = "https://cdn.winget.microsoft.com/cache";
const APPROVE = "Approve installation";
const CANCEL = "Cancel";
const SHOW_MANUAL = "Show manual instructions";

const WIN_PROGRAM_FILES = "C:\\Program Files";
const WIN_LOCAL_APP_DATA = "C:\\Users\\dev\\AppData\\Local";
const WIN_WINGET_PKG_DIR = `${WIN_LOCAL_APP_DATA}\\Microsoft\\WinGet\\Packages`;
const WIN_WINGET_EXE = `${WIN_LOCAL_APP_DATA}\\Microsoft\\WindowsApps\\winget.exe`;
const sourceExport = (
  Arg = WINGET_OFFICIAL_CDN,
  Name = "winget",
  Type = "Microsoft.PreIndexed.Package",
) => JSON.stringify({ Name, Arg, Type });

interface RecordedCall {
  command: string;
  args: readonly string[];
  signal?: AbortSignal;
}

interface Harness {
  calls: RecordedCall[];
  runner: Runner;
  which: Which;
  pathExists: PathExists;
  searchPath: SearchPath;
  installResult: (command: string, args: readonly string[]) => "ok" | "fail";
  // The four function fields above are filled in by `makeHarness` before the
  // harness escapes. The type marks them as non-optional to keep call sites
  // concise; the actual assignment happens immediately after the object
  // literal is built.
  // Mutable knobs the test can use to flip a path or env mid-test.
  wingetSourceExportOutput: string;
  whichMap: Map<string, string | undefined>;
  existsMap: Map<string, boolean>;
  searchMap: Map<string, string | undefined>;
  env: NodeJS.ProcessEnv;
}

function makeHarness(initial?: {
  wingetSourceExportOutput?: string;
  whichMap?: Map<string, string | undefined>;
  existsMap?: Map<string, boolean>;
  searchMap?: Map<string, string | undefined>;
  env?: NodeJS.ProcessEnv;
  installResult?: (command: string, args: readonly string[]) => "ok" | "fail";
  /**
   * When true, the path-discovery helpers (`which`, `pathExists`,
   * `searchPath`) return their configured values immediately, as if the
   * binaries were already installed before the harness started. The
   * default (false) gates the helpers on the install-call count so tests
   * can simulate "the binary appears only after the install ran".
   */
  preInstalled?: boolean;
}): Harness {
  const calls: RecordedCall[] = [];
  // Number of install invocations so far. The path-discovery helpers
  // (`which`, `pathExists`, `searchPath`) gate their results on this count
  // so the test can simulate "the binary appears only after the install
  // ran": leave the maps populated but set the count to 0; after the
  // runner records the install call, the helpers start returning the
  // configured paths.
  let installCount = 0;
  const preInstalled = initial?.preInstalled ?? false;
  const state: Harness = {
    calls,
    wingetSourceExportOutput:
      initial?.wingetSourceExportOutput ?? sourceExport(),
    whichMap: initial?.whichMap ?? new Map(),
    existsMap: initial?.existsMap ?? new Map(),
    searchMap: initial?.searchMap ?? new Map(),
    env: initial?.env ?? {},
    installResult: initial?.installResult ?? (() => "ok"),
  } as Harness;
  state.runner = async (command, args, signal) => {
    calls.push({ command, args, signal });
    // The runner may be invoked with either a bare command name (e.g.
    // "winget") or an absolute path to the binary (e.g. when probing a
    // candidate that was already discovered). Normalize by matching the
    // basename.
    const base = command.split(/[\\/]/).pop() ?? command;
    const baseLower = base.toLowerCase();
    if (baseLower === "winget" || baseLower === "winget.exe") {
      if (args[0] === "--version") return "v1.7.1058\n";
      if (args[0] === "source" && args[1] === "export")
        return state.wingetSourceExportOutput;
      if (args[0] === "install") {
        installCount++;
        return state.installResult(command, args) === "ok"
          ? "Installed successfully"
          : (() => {
              throw new Error(
                `${command} failed (1): simulated install failure`,
              );
            })();
      }
    }
    if (
      (baseLower === "brew" || baseLower === "brew.cmd") &&
      args[0] === "--version"
    )
      return "Homebrew 4.2.0\n";
    if (baseLower === "apt-get" && args[0] === "--version")
      return "apt 2.6.0 (amd64)\n";
    if (
      (baseLower === "soffice" || baseLower === "soffice.exe") &&
      args[0] === "--version"
    )
      return "LibreOffice 24.2.7.2 a8a1aa1ba8a1aa1ba8a1aa1ba8a1aa1ba8a1aa1b\n";
    if (
      (baseLower === "pdftoppm" || baseLower === "pdftoppm.exe") &&
      args[0] === "-v"
    )
      return "pdftoppm version 24.02.0\n";
    if (state.installResult(command, args) === "ok")
      return "Installed successfully";
    throw new Error(`${command} failed (1): simulated install failure`);
  };
  state.which = async (command) => {
    if (!preInstalled && installCount === 0) return undefined;
    return state.whichMap.get(command);
  };
  state.pathExists = async (p) => {
    if (p === WIN_WINGET_EXE) return true;
    if (!preInstalled && installCount === 0) return false;
    return state.existsMap.get(p) ?? [...state.searchMap.values()].includes(p);
  };
  state.searchPath = async (root, binaryName) => {
    if (!preInstalled && installCount === 0) return undefined;
    for (const [k, v] of state.searchMap) {
      if (k === `${root}::${binaryName}`) return v;
    }
    return undefined;
  };
  return state;
}

function baseOptions(h: Harness): DependencyOptions {
  return {
    runner: h.runner,
    which: h.which,
    pathExists: h.pathExists,
    searchPath: h.searchPath,
    platform: "win32",
    env: h.env,
    home: "C:\\Users\\dev",
    localAppData: WIN_LOCAL_APP_DATA,
    programDirs: [WIN_PROGRAM_FILES, `${WIN_PROGRAM_FILES} (x86)`],
    wingetPackageDir: WIN_WINGET_PKG_DIR,
    wingetPath: WIN_WINGET_EXE,
    probeTimeoutMs: 5_000,
  };
}

function recordingUI(
  choice: (title: string, options: string[]) => string | undefined,
): {
  ui: DependencyUI;
  notifications: Array<{ message: string; type: "info" | "warning" | "error" }>;
  selects: string[];
} {
  const notifications: Array<{
    message: string;
    type: "info" | "warning" | "error";
  }> = [];
  const selects: string[] = [];
  return {
    ui: {
      select: async (title, options) => {
        selects.push(title);
        return choice(title, options);
      },
      notify: (message, type = "info") => {
        notifications.push({ message, type });
      },
    },
    notifications,
    selects,
  };
}

function alreadyInstalledHarness(): Harness {
  const soffice = `${WIN_PROGRAM_FILES}\\LibreOffice\\program\\soffice.exe`;
  const pdftoppm = `${WIN_LOCAL_APP_DATA}\\Microsoft\\WinGet\\Packages\\oschwartz10612.Poppler_v0.1.0_x64__8wekyb3d8bbwe\\poppler-24.02.0\\Library\\bin\\pdftoppm.exe`;
  return makeHarness({
    preInstalled: true,
    whichMap: new Map([
      ["soffice", soffice],
      ["pdftoppm", pdftoppm],
    ]),
  });
}

test("inspectDependencies reports installed when both binaries are on PATH and win32", async () => {
  const h = alreadyInstalledHarness();
  const report = await inspectDependencies(undefined, baseOptions(h));
  assert.equal(report.platform, "win32");
  assert.equal(report.supportedPlatform, true);
  assert.equal(report.supportedPackageManager, "winget");
  assert.ok(report.packageManager);
  assert.equal(report.packageManager.available, true);
  assert.equal(report.packageManager.sourceValidation.passed, true);
  assert.ok(
    report.packageManager.sourceValidation.details.includes(
      WINGET_OFFICIAL_CDN,
    ),
  );
  assert.equal(report.ready, true);
  for (const binary of report.binaries) {
    assert.equal(binary.status, "installed");
    assert.ok(binary.resolvedPath);
    assert.ok(
      (binary.version && binary.version.includes("LibreOffice")) ||
        (binary.version && binary.version.includes("pdftoppm")),
    );
  }
});

test("inspectDependencies reports missing when binaries are not found and preInstall is set", async () => {
  const h = makeHarness();
  const report = await inspectDependencies(undefined, baseOptions(h));
  assert.equal(report.ready, false);
  assert.equal(report.preInstall, true);
  assert.equal(report.binaries[0].command, "soffice");
  assert.equal(report.binaries[0].status, "missing");
  assert.equal(report.binaries[0].packageId, WINGET_LIBREOFFICE_ID);
  assert.equal(report.binaries[1].command, "pdftoppm");
  assert.equal(report.binaries[1].status, "missing");
  assert.equal(report.binaries[1].packageId, WINGET_POPPLER_ID);
});

test("inspectDependencies reports unsupported on darwin without enableNonWindowsPlatforms", async () => {
  const h = makeHarness();
  const report = await inspectDependencies(undefined, {
    ...baseOptions(h),
    platform: "darwin",
  });
  assert.equal(report.supportedPlatform, false);
  assert.equal(report.supportedPackageManager, null);
  assert.equal(report.packageManager, null);
  for (const binary of report.binaries) {
    assert.equal(binary.status, "unsupported");
  }
  assert.ok(report.manualInstructions.includes("darwin"));
});

test("inspectDependencies reports unsupported on linux without enableNonWindowsPlatforms", async () => {
  const h = makeHarness();
  const report = await inspectDependencies(undefined, {
    ...baseOptions(h),
    platform: "linux",
  });
  assert.equal(report.supportedPlatform, false);
  assert.equal(report.supportedPackageManager, null);
  for (const binary of report.binaries) {
    assert.equal(binary.status, "unsupported");
  }
});

test("ensureDependencies returns immediately without prompting when everything is installed", async () => {
  const h = alreadyInstalledHarness();
  const { ui, selects, notifications } = recordingUI(() => APPROVE);
  const tools = await ensureDependencies(ui, undefined, baseOptions(h));
  assert.equal(selects.length, 0, "no UI prompt when already installed");
  assert.ok(notifications.some((n) => n.message.includes("already installed")));
  assert.ok(tools.soffice.endsWith("soffice.exe"));
  assert.ok(tools.pdftoppm.endsWith("pdftoppm.exe"));
  // No install command should have been recorded.
  assert.equal(
    h.calls.filter(
      (c) => c.command === WIN_WINGET_EXE && c.args[0] === "install",
    ).length,
    0,
  );
});

test("ensureDependencies cancel via undefined select performs zero installs", async () => {
  const h = makeHarness();
  const { ui, selects } = recordingUI(() => undefined);
  await assert.rejects(
    () => ensureDependencies(ui, undefined, baseOptions(h)),
    (err: unknown) =>
      err instanceof DependencyError &&
      /no UI response|cancelled/.test(err.message),
  );
  assert.equal(selects.length, 1);
  assert.match(selects[0], /Any other selection performs zero installs/);
  assert.match(selects[0], /exact argv:/);
  assert.match(selects[0], /Windows UAC/);
  assert.match(selects[0], /planHash: [0-9a-f]{64}/);
  // No install should have been recorded.
  assert.equal(
    h.calls.filter(
      (c) => c.command === WIN_WINGET_EXE && c.args[0] === "install",
    ).length,
    0,
  );
});

test("ensureDependencies cancel via Cancel literal performs zero installs", async () => {
  const h = makeHarness();
  const { ui } = recordingUI(() => CANCEL);
  await assert.rejects(
    () => ensureDependencies(ui, undefined, baseOptions(h)),
    (err: unknown) =>
      err instanceof DependencyError && /cancelled by user/.test(err.message),
  );
  assert.equal(
    h.calls.filter(
      (c) => c.command === WIN_WINGET_EXE && c.args[0] === "install",
    ).length,
    0,
  );
});

test("ensureDependencies Show manual instructions performs zero installs and reports instructions", async () => {
  const h = makeHarness();
  const { ui, notifications } = recordingUI(() => SHOW_MANUAL);
  await assert.rejects(
    () => ensureDependencies(ui, undefined, baseOptions(h)),
    (err: unknown) =>
      err instanceof DependencyError && /manual instructions/.test(err.message),
  );
  assert.equal(
    h.calls.filter(
      (c) => c.command === WIN_WINGET_EXE && c.args[0] === "install",
    ).length,
    0,
  );
  assert.ok(
    notifications.some((n) =>
      n.message.includes("Pi Presenter render dependencies"),
    ),
  );
});

test("ensureDependencies Approve installation runs the exact argv for each missing binary", async () => {
  const h = makeHarness();
  // After install, the binary gets discovered via the search path.
  h.searchMap.set(
    `${WIN_WINGET_PKG_DIR}::pdftoppm.exe`,
    `${WIN_WINGET_PKG_DIR}\\oschwartz10612.Poppler_v0.1.0_x64__8wekyb3d8bbwe\\poppler-24.02.0\\Library\\bin\\pdftoppm.exe`,
  );
  h.existsMap.set(
    `${WIN_PROGRAM_FILES}\\LibreOffice\\program\\soffice.exe`,
    true,
  );
  const { ui, notifications } = recordingUI(() => APPROVE);
  const tools = await ensureDependencies(ui, undefined, baseOptions(h));
  assert.ok(tools.soffice.endsWith("soffice.exe"));
  assert.ok(tools.pdftoppm.endsWith("pdftoppm.exe"));

  // The two install calls should have the exact fixed argv.
  const installs = h.calls.filter(
    (c) => c.command === WIN_WINGET_EXE && c.args[0] === "install",
  );
  assert.equal(installs.length, 2);
  assert.deepEqual(
    [...installs[0].args],
    [
      "install",
      "--id",
      WINGET_LIBREOFFICE_ID,
      "--scope",
      "machine",
      "--accept-source-agreements",
      "--accept-package-agreements",
      "--exact",
      "--source",
      "winget",
      "--disable-interactivity",
      "--no-upgrade",
    ],
  );
  assert.deepEqual(
    [...installs[1].args],
    [
      "install",
      "--id",
      WINGET_POPPLER_ID,
      "--scope",
      "user",
      "--accept-source-agreements",
      "--accept-package-agreements",
      "--exact",
      "--source",
      "winget",
      "--disable-interactivity",
      "--no-upgrade",
    ],
  );
  // The approval summary notification must show the full argv and the
  // elevation / source disclosure.
  const summary = notifications.find((n) =>
    n.message.includes("Pi Presenter install plan"),
  );
  assert.ok(summary);
  assert.ok(
    summary!.message.includes(
      `exact argv: ${WIN_WINGET_EXE} install --id ${WINGET_LIBREOFFICE_ID}`,
    ),
  );
  assert.ok(
    summary!.message.includes(
      `exact argv: ${WIN_WINGET_EXE} install --id ${WINGET_POPPLER_ID}`,
    ),
  );
  assert.ok(summary!.message.includes(WINGET_OFFICIAL_CDN));
  assert.ok(summary!.message.includes("COMMUNITY-MAINTAINED"));
  assert.ok(summary!.message.includes("elevation: requiresAdmin=true"));
  assert.ok(summary!.message.includes("scope=system"));
  // planHash should be present in the summary.
  assert.ok(/planHash: [0-9a-f]{64}/.test(summary!.message));
});

test("ensureDependencies no shell: no command in runner calls is a shell binary", async () => {
  const h = makeHarness();
  h.searchMap.set(
    `${WIN_WINGET_PKG_DIR}::pdftoppm.exe`,
    `${WIN_WINGET_PKG_DIR}\\oschwartz10612.Poppler_v0.1.0_x64__8wekyb3d8bbwe\\poppler-24.02.0\\Library\\bin\\pdftoppm.exe`,
  );
  h.existsMap.set(
    `${WIN_PROGRAM_FILES}\\LibreOffice\\program\\soffice.exe`,
    true,
  );
  const { ui } = recordingUI(() => APPROVE);
  await ensureDependencies(ui, undefined, baseOptions(h));
  const banned = new Set([
    "bash",
    "sh",
    "cmd",
    "powershell",
    "pwsh",
    "zsh",
    "fish",
    "sudo",
    "su",
    "curl",
    "wget",
  ]);
  for (const call of h.calls) {
    assert.ok(
      !banned.has(call.command),
      `shell-like command used: ${call.command}`,
    );
  }
});

test("ensureDependencies fixed argv: install tokens are exactly the fixed list, no shell metachars", async () => {
  const h = makeHarness();
  h.searchMap.set(
    `${WIN_WINGET_PKG_DIR}::pdftoppm.exe`,
    `${WIN_WINGET_PKG_DIR}\\oschwartz10612.Poppler_v0.1.0_x64__8wekyb3d8bbwe\\poppler-24.02.0\\Library\\bin\\pdftoppm.exe`,
  );
  h.existsMap.set(
    `${WIN_PROGRAM_FILES}\\LibreOffice\\program\\soffice.exe`,
    true,
  );
  const { ui } = recordingUI(() => APPROVE);
  await ensureDependencies(ui, undefined, baseOptions(h));
  const installCalls = h.calls.filter(
    (c) => c.command === WIN_WINGET_EXE && c.args[0] === "install",
  );
  assert.equal(installCalls.length, 2);
  for (const call of installCalls) {
    for (const arg of call.args) {
      for (const ch of [
        "|",
        "&",
        ";",
        ">",
        "<",
        "`",
        "$",
        "*",
        "?",
        "\n",
        "\r",
      ]) {
        assert.ok(
          !arg.includes(ch),
          `install arg contains shell metachar ${JSON.stringify(ch)}: ${arg}`,
        );
      }
    }
  }
});

test("ensureDependencies changed plan between approval and execution is rejected", async () => {
  const h = makeHarness();
  h.searchMap.set(
    `${WIN_WINGET_PKG_DIR}::pdftoppm.exe`,
    `${WIN_WINGET_PKG_DIR}\\oschwartz10612.Poppler_v0.1.0_x64__8wekyb3d8bbwe\\poppler-24.02.0\\Library\\bin\\pdftoppm.exe`,
  );
  h.existsMap.set(
    `${WIN_PROGRAM_FILES}\\LibreOffice\\program\\soffice.exe`,
    true,
  );

  // The first inspectDependencies call (during ensureDependencies) will
  // produce plan A. We mutate the environment after that to flip the source
  // URL to a spoofed value. The second call (re-check) will produce plan B
  // with a different hash.
  let firstInspect = true;
  const wrapRunner: Runner = async (command, args, signal) => {
    if (
      firstInspect &&
      command === WIN_WINGET_EXE &&
      args[0] === "source" &&
      args[1] === "export"
    ) {
      firstInspect = false;
      return sourceExport();
    }
    if (
      !firstInspect &&
      command === WIN_WINGET_EXE &&
      args[0] === "source" &&
      args[1] === "export"
    ) {
      return sourceExport("https://attacker.example.com/cache");
    }
    return h.runner(command, args, signal);
  };

  // The shared `which`/`pathExists`/`searchPath` are unchanged so the
  // binary status is the same; only the packageManager probe differs.
  const opts: DependencyOptions = {
    ...baseOptions(h),
    runner: wrapRunner,
  };
  const { ui } = recordingUI(() => APPROVE);
  await assert.rejects(
    () => ensureDependencies(ui, undefined, opts),
    (err: unknown) =>
      err instanceof DependencyError &&
      /plan changed after approval/.test(err.message),
  );
  // Crucially: no install command should have been recorded.
  assert.equal(
    h.calls.filter(
      (c) => c.command === WIN_WINGET_EXE && c.args[0] === "install",
    ).length,
    0,
  );
});

test("ensureDependencies post-install missing binary throws and does not claim success", async () => {
  const h = makeHarness();
  // After the first install, soffice becomes discoverable on the candidate
  // path, so the loop proceeds to the second install. The second install
  // (pdftoppm) has no path configured, so its post-install probe fails and
  // the function throws — proving the function never claims success based
  // on the installer's exit code alone.
  h.existsMap.set(
    `${WIN_PROGRAM_FILES}\\LibreOffice\\program\\soffice.exe`,
    true,
  );
  const { ui } = recordingUI(() => APPROVE);
  await assert.rejects(
    () => ensureDependencies(ui, undefined, baseOptions(h)),
    (err: unknown) =>
      err instanceof DependencyError &&
      /reported success but .* was not found/.test(err.message),
  );
  // Both installs were attempted (because the runner returns "ok"), but the
  // second re-probe rejected the result.
  const installCalls = h.calls.filter(
    (c) => c.command === WIN_WINGET_EXE && c.args[0] === "install",
  );
  assert.equal(installCalls.length, 2);
});

test("ensureDependencies missing UI throws without installing", async () => {
  const h = makeHarness();
  const badUI = {} as DependencyUI;
  await assert.rejects(
    () => ensureDependencies(badUI, undefined, baseOptions(h)),
    (err: unknown) =>
      err instanceof DependencyError &&
      /Native UI is required/.test(err.message),
  );
  assert.equal(
    h.calls.filter(
      (c) => c.command === WIN_WINGET_EXE && c.args[0] === "install",
    ).length,
    0,
  );
});

test("ensureDependencies aborts when signal is aborted before install", async () => {
  const h = makeHarness();
  h.searchMap.set(
    `${WIN_WINGET_PKG_DIR}::pdftoppm.exe`,
    `${WIN_WINGET_PKG_DIR}\\oschwartz10612.Poppler_v0.1.0_x64__8wekyb3d8bbwe\\poppler-24.02.0\\Library\\bin\\pdftoppm.exe`,
  );
  h.existsMap.set(
    `${WIN_PROGRAM_FILES}\\LibreOffice\\program\\soffice.exe`,
    true,
  );
  const controller = new AbortController();
  controller.abort(new Error("user cancel"));
  // The runner, when invoked with an aborted signal, must throw per AbortSignal contract.
  const { ui } = recordingUI(() => APPROVE);
  await assert.rejects(
    () => ensureDependencies(ui, controller.signal, baseOptions(h)),
    (err: unknown) =>
      err instanceof DependencyError ||
      (err instanceof Error && /aborted|cancel/.test(err.message)),
  );
  // The pre-aborted signal must propagate; either the install never ran or
  // it was rejected before returning. The call must not have returned a
  // successful `RenderTools`.
});

test("ensureDependencies on unsupported platform throws without installing", async () => {
  const h = makeHarness();
  const { ui, notifications } = recordingUI(() => APPROVE);
  await assert.rejects(
    () =>
      ensureDependencies(ui, undefined, {
        ...baseOptions(h),
        platform: "darwin",
      }),
    (err: unknown) =>
      err instanceof DependencyError &&
      /not supported by the automated installer/.test(err.message),
  );
  // No install should have run (not even brew).
  assert.equal(
    h.calls.filter((c) => c.command === "brew" && c.args[0] === "install")
      .length,
    0,
  );
  assert.ok(notifications.some((n) => n.type === "error"));
});

test("inspectDependencies rejects custom WinGet source URL", async () => {
  const h = makeHarness({
    wingetSourceExportOutput: sourceExport(
      "https://attacker.example.com/cache",
    ),
  });
  const report = await inspectDependencies(undefined, baseOptions(h));
  assert.equal(report.supportedPlatform, true);
  assert.equal(report.supportedPackageManager, "winget");
  assert.equal(report.packageManager?.available, false);
  assert.equal(report.packageManager?.sourceValidation.passed, false);
  assert.ok(
    report.packageManager?.sourceValidation.details.includes(
      "attacker.example.com",
    ),
  );
  // The report is still build-able; preInstall is false because the manager is unavailable.
  assert.equal(report.preInstall, false);
});

test("inspectDependencies rejects unknown source name", async () => {
  const h = makeHarness({
    wingetSourceExportOutput: sourceExport(
      "https://storeedgefd.dsx.mp.microsoft.com",
      "msstore",
    ),
  });
  const report = await inspectDependencies(undefined, baseOptions(h));
  assert.equal(report.packageManager?.available, false);
  assert.ok(report.packageManager?.sourceValidation.details.includes("winget"));
});

test("ensureDependencies rejects custom WinGet source URL", async () => {
  const h = makeHarness({
    wingetSourceExportOutput: sourceExport(
      "https://attacker.example.com/cache",
    ),
  });
  const { ui, notifications } = recordingUI(() => APPROVE);
  await assert.rejects(
    () => ensureDependencies(ui, undefined, baseOptions(h)),
    (err: unknown) =>
      err instanceof DependencyError &&
      /source is not validated|attacker\.example\.com/.test(err.message),
  );
  // No install attempted.
  assert.equal(
    h.calls.filter(
      (c) => c.command === WIN_WINGET_EXE && c.args[0] === "install",
    ).length,
    0,
  );
  assert.ok(notifications.some((n) => n.type === "error"));
});

test("inspectDependencies rejects Homebrew env override (source spoofing)", async () => {
  const h = makeHarness({
    env: { HOMEBREW_GIT_URL: "https://attacker.example.com/brew.git" },
  });
  const report = await inspectDependencies(undefined, {
    ...baseOptions(h),
    platform: "darwin",
    enableNonWindowsPlatforms: true,
  });
  assert.equal(report.supportedPlatform, true);
  assert.equal(report.supportedPackageManager, "brew");
  assert.equal(report.packageManager?.available, false);
  assert.ok(
    report.packageManager?.sourceValidation.details.includes(
      "HOMEBREW_GIT_URL",
    ),
  );
});

test("ensureDependencies refuses to install via brew with spoofed HOMEBREW env", async () => {
  const h = makeHarness({
    env: { HOMEBREW_API_DOMAIN: "https://attacker.example.com" },
  });
  const { ui } = recordingUI(() => APPROVE);
  await assert.rejects(
    () =>
      ensureDependencies(ui, undefined, {
        ...baseOptions(h),
        platform: "darwin",
        enableNonWindowsPlatforms: true,
      }),
    (err: unknown) =>
      err instanceof DependencyError &&
      /HOMEBREW_API_DOMAIN|source is not validated/.test(err.message),
  );
  assert.equal(
    h.calls.filter((c) => c.command === "brew" && c.args[0] === "install")
      .length,
    0,
  );
});

test("inspectDependencies exposes the full brew install argv when manager is available", async () => {
  const h = makeHarness();
  const report = await inspectDependencies(undefined, {
    ...baseOptions(h),
    platform: "darwin",
    enableNonWindowsPlatforms: true,
  });
  assert.equal(report.packageManager?.available, true);
  for (const binary of report.binaries) {
    assert.ok(
      binary.installArgs.includes("--cask") ||
        binary.installArgs.includes("poppler"),
    );
    assert.equal(binary.installCommand, "brew");
  }
});

test("inspectDependencies on linux defaults to unsupported (no root allowed)", async () => {
  const h = makeHarness();
  const report = await inspectDependencies(undefined, {
    ...baseOptions(h),
    platform: "linux",
    enableNonWindowsPlatforms: true,
  });
  assert.equal(report.supportedPlatform, true);
  assert.equal(report.supportedPackageManager, "apt");
  assert.equal(report.packageManager?.available, false);
  assert.ok(report.packageManager?.sourceValidation.details.includes("root"));
});

test("inspectDependencies on linux with allowAptWithElevation but no /etc/apt/sources.list reports failure", async () => {
  const h = makeHarness();
  // No /etc/apt/sources.list exists on a non-Linux dev machine, so the
  // default implementation falls through to "Cannot read /etc/apt/sources.list".
  const report = await inspectDependencies(undefined, {
    ...baseOptions(h),
    platform: "linux",
    enableNonWindowsPlatforms: true,
    allowAptWithElevation: true,
  });
  assert.equal(report.packageManager?.available, false);
});

test("planHash is stable across identical reports and changes when state changes", async () => {
  const h1 = makeHarness();
  const r1 = await inspectDependencies(undefined, baseOptions(h1));
  const r2 = await inspectDependencies(undefined, baseOptions(h1));
  assert.equal(r1.planHash, r2.planHash);

  // Adding a binary path changes the hash.
  const h2 = makeHarness({ preInstalled: true });
  h2.whichMap.set(
    "soffice",
    `${WIN_PROGRAM_FILES}\\LibreOffice\\program\\soffice.exe`,
  );
  const r3 = await inspectDependencies(undefined, baseOptions(h2));
  assert.notEqual(r1.planHash, r3.planHash);
});

test("DependencyError carries the report it was thrown with", async () => {
  const h = makeHarness();
  const { ui } = recordingUI(() => CANCEL);
  try {
    await ensureDependencies(ui, undefined, baseOptions(h));
    assert.fail("expected DependencyError");
  } catch (e) {
    assert.ok(e instanceof DependencyError);
    assert.equal((e as DependencyError).report.platform, "win32");
    assert.ok((e as DependencyError).report.manualInstructions.length > 0);
  }
});

test("resolveRenderTools returns paths when installed", async () => {
  const h = alreadyInstalledHarness();
  const tools = await resolveRenderTools(undefined, baseOptions(h));
  assert.ok(tools.soffice.endsWith("soffice.exe"));
  assert.ok(tools.pdftoppm.endsWith("pdftoppm.exe"));
});

test("resolveRenderTools throws DependencyError when missing on supported platform", async () => {
  const h = makeHarness();
  await assert.rejects(
    () => resolveRenderTools(undefined, baseOptions(h)),
    (err: unknown) =>
      err instanceof DependencyError && /not all available/.test(err.message),
  );
});

test("resolveRenderTools throws DependencyError when missing on unsupported platform (no install attempted)", async () => {
  const h = makeHarness();
  await assert.rejects(
    () =>
      resolveRenderTools(undefined, { ...baseOptions(h), platform: "darwin" }),
    (err: unknown) =>
      err instanceof DependencyError && /not all available/.test(err.message),
  );
  // No runner call for any package manager should have been recorded.
  assert.equal(
    h.calls.filter(
      (c) =>
        c.command === "brew" ||
        c.command === WIN_WINGET_EXE ||
        c.command === "apt-get",
    ).length,
    0,
  );
});

test("inspectDependencies is read-only: never invokes install", async () => {
  const h = makeHarness();
  await inspectDependencies(undefined, baseOptions(h));
  assert.equal(h.calls.filter((c) => c.args[0] === "install").length, 0);
});

test("DependencyReport is JSON-serializable (no functions, no symbols)", async () => {
  const h = makeHarness();
  const report = await inspectDependencies(undefined, baseOptions(h));
  const json = JSON.stringify(report);
  const round = JSON.parse(json) as DependencyReport;
  assert.equal(round.platform, report.platform);
  assert.equal(round.planHash, report.planHash);
});

test("approval dialog title includes OS, package manager, missing list, and literal approve action", async () => {
  const h = makeHarness();
  const { ui, selects } = recordingUI(() => APPROVE);
  h.searchMap.set(
    `${WIN_WINGET_PKG_DIR}::pdftoppm.exe`,
    `${WIN_WINGET_PKG_DIR}\\oschwartz10612.Poppler_v0.1.0_x64__8wekyb3d8bbwe\\poppler-24.02.0\\Library\\bin\\pdftoppm.exe`,
  );
  h.existsMap.set(
    `${WIN_PROGRAM_FILES}\\LibreOffice\\program\\soffice.exe`,
    true,
  );
  await ensureDependencies(ui, undefined, baseOptions(h));
  assert.equal(selects.length, 1);
  const title = selects[0];
  assert.ok(title.includes("Platform: win32"));
  assert.ok(title.includes("Package manager: winget"));
  assert.ok(title.includes("Missing: soffice, pdftoppm"));
  assert.ok(title.includes(APPROVE));
  // Choices passed to the select must include the approve literal AND
  // a non-install option.
  // (We don't have access to the choices array directly, but the cancel
  // test above already covers that branch.)
});

test("ensureDependencies aborts the install when AbortSignal fires mid-flight", async () => {
  const h = makeHarness();
  // The runner never gets past the first install before the abort fires.
  h.searchMap.set(
    `${WIN_WINGET_PKG_DIR}::pdftoppm.exe`,
    `${WIN_WINGET_PKG_DIR}\\oschwartz10612.Poppler_v0.1.0_x64__8wekyb3d8bbwe\\poppler-24.02.0\\Library\\bin\\pdftoppm.exe`,
  );
  h.existsMap.set(
    `${WIN_PROGRAM_FILES}\\LibreOffice\\program\\soffice.exe`,
    true,
  );
  const controller = new AbortController();
  // Wrap the runner to abort the signal as soon as an install call fires.
  const wrapRunner: Runner = async (command, args, signal) => {
    if (
      command === WIN_WINGET_EXE &&
      args[0] === "install" &&
      !signal?.aborted
    ) {
      // Schedule the abort to fire on the next microtask.
      queueMicrotask(() => controller.abort(new Error("user cancel")));
    }
    if (signal?.aborted) throw new Error("aborted");
    return h.runner(command, args, signal);
  };
  const { ui } = recordingUI(() => APPROVE);
  await assert.rejects(
    () =>
      ensureDependencies(ui, controller.signal, {
        ...baseOptions(h),
        runner: wrapRunner,
      }),
    (err: unknown) =>
      err instanceof DependencyError ||
      (err instanceof Error && /aborted|cancel/.test(err.message)),
  );
  // The second install must not have run.
  const installCalls = h.calls.filter(
    (c) => c.command === WIN_WINGET_EXE && c.args[0] === "install",
  );
  assert.ok(
    installCalls.length <= 1,
    `expected at most one install before abort, got ${installCalls.length}`,
  );
});

test("existing render tools remain usable on macOS/Linux without enabling auto-install", async () => {
  for (const platform of ["darwin", "linux"] as const) {
    const h = makeHarness({
      preInstalled: true,
      whichMap: new Map([
        ["soffice", "/usr/bin/soffice"],
        ["pdftoppm", "/usr/bin/pdftoppm"],
      ]),
    });
    const { ui, selects } = recordingUI(() => {
      throw new Error("unexpected install prompt");
    });
    const opts = { ...baseOptions(h), platform };
    const report = await inspectDependencies(undefined, opts);
    assert.equal(report.supportedPlatform, false);
    assert.equal(report.ready, true);
    assert.deepEqual(await ensureDependencies(ui, undefined, opts), {
      soffice: "/usr/bin/soffice",
      pdftoppm: "/usr/bin/pdftoppm",
    });
    assert.equal(selects.length, 0);
    assert.ok(h.calls.every((call) => call.args[0] !== "install"));
  }
});

test("WinGet checks require an absolute trusted alias and exact exported source type", async () => {
  const h = makeHarness();
  const unsafe = await inspectDependencies(undefined, {
    ...baseOptions(h),
    wingetPath: "winget.exe",
  });
  assert.equal(unsafe.packageManager?.available, false);
  assert.equal(h.calls.length, 0);
  h.wingetSourceExportOutput = sourceExport(
    WINGET_OFFICIAL_CDN,
    "winget",
    "Untrusted.Source",
  );
  const wrongType = await inspectDependencies(undefined, baseOptions(h));
  assert.equal(wrongType.packageManager?.available, false);
  assert.ok(
    h.calls.every(
      (c) => c.command === WIN_WINGET_EXE && c.args[0] !== "install",
    ),
  );
  assert.ok(
    h.calls.some(
      (c) =>
        JSON.stringify(c.args) ===
        JSON.stringify(["source", "export", "--name", "winget"]),
    ),
  );
});

test("changed package-manager version invalidates installation approval", async () => {
  const h = makeHarness();
  let changed = false;
  const { ui } = recordingUI(() => {
    changed = true;
    return APPROVE;
  });
  const runner: Runner = (command, args, signal) =>
    changed && command === WIN_WINGET_EXE && args[0] === "--version"
      ? Promise.resolve("v1.8.0")
      : h.runner(command, args, signal);
  await assert.rejects(
    () => ensureDependencies(ui, undefined, { ...baseOptions(h), runner }),
    /plan changed/,
  );
  assert.equal(h.calls.filter((c) => c.args[0] === "install").length, 0);
});

test("installation timeout aborts the runner instead of leaving it running", async () => {
  const h = makeHarness();
  let aborted = false;
  let installs = 0;
  const runner: Runner = (command, args, signal) => {
    if (args[0] !== "install") return h.runner(command, args, signal);
    installs++;
    return new Promise((_resolve, reject) =>
      signal?.addEventListener(
        "abort",
        () => {
          aborted = true;
          reject(signal.reason);
        },
        { once: true },
      ),
    );
  };
  const { ui } = recordingUI(() => APPROVE);
  await assert.rejects(
    () =>
      ensureDependencies(ui, undefined, {
        ...baseOptions(h),
        runner,
        installerTimeoutMs: 20,
      }),
    /timeout/,
  );
  assert.equal(aborted, true);
  assert.equal(installs, 1);
});

test("the native approval dialog includes exact paths, permissions, community trust and plan hash", async () => {
  const h = makeHarness();
  const { ui, selects } = recordingUI(() => CANCEL);
  await assert.rejects(
    () => ensureDependencies(ui, undefined, baseOptions(h)),
    /cancelled/,
  );
  assert.match(selects[0], /requiresAdmin=true.*scope=system/);
  assert.match(selects[0], /COMMUNITY-MAINTAINED/);
  assert.ok(selects[0].includes(`exact argv: ${WIN_WINGET_EXE}`));
  assert.match(selects[0], /--scope machine/);
  assert.match(selects[0], /--no-upgrade/);
  assert.match(selects[0], /planHash: [0-9a-f]{64}/);
});

test("Windows Store alias validation accepts only the protected Microsoft App Installer package identity", () => {
  const legitimate =
    "C:\\Program Files\\WindowsApps\\Microsoft.DesktopAppInstaller_1.29.380.0_x64__8wekyb3d8bbwe\\winget.exe";
  assert.equal(
    isTrustedAppInstallerTarget(legitimate, [WIN_PROGRAM_FILES]),
    true,
  );
  for (const target of [
    "winget.exe",
    "C:\\Project\\winget.exe",
    legitimate.replace("8wekyb3d8bbwe", "attacker"),
    legitimate.replace("Microsoft.DesktopAppInstaller", "Untrusted.Installer"),
    legitimate.replace("C:\\Program Files", "C:\\Project"),
    legitimate.replace("winget.exe", "other.exe"),
  ])
    assert.equal(
      isTrustedAppInstallerTarget(target, [WIN_PROGRAM_FILES]),
      false,
      target,
    );
});
