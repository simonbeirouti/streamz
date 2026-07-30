import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const tauriRoot = join(projectRoot, "src-tauri");
const packageJson = JSON.parse(
  await readFile(join(projectRoot, "package.json"), "utf8"),
);
const appVersion = packageJson.version;
const obsVersion = "32.2.1";
const obsDmgName = `OBS-Studio-${obsVersion}-macOS-Apple.dmg`;
const obsDmgSha256 =
  "6120c995614be17ecd0ee0877514a88b121249e6261cde46d1440b87d7ffd70c";
const obsDmg = join(projectRoot, ".obs-cache", obsVersion, obsDmgName);
const cargoTargetDir = join(tauriRoot, "target-package");
const appBundle = join(
  cargoTargetDir,
  "release",
  "bundle",
  "macos",
  "Streamz.app",
);
const outputDir = join(tauriRoot, "target", "release", "bundle", "pkg");
const architecture = process.arch === "arm64" ? "aarch64" : process.arch;
const outputPackage = join(
  outputDir,
  `Streamz_${appVersion}_${architecture}.pkg`,
);

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      env: options.env ?? process.env,
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let stdout = "";
    let stderr = "";
    if (options.capture) {
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
    }
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolvePromise({ stdout, stderr });
      } else {
        reject(
          new Error(
            `${command} exited with status ${code}${
              stderr ? `\n${stderr.trim()}` : ""
            }`,
          ),
        );
      }
    });
  });
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function digest(path) {
  const file = await open(path, "r");
  const hash = createHash("sha256");
  for await (const chunk of file.createReadStream()) hash.update(chunk);
  return hash.digest("hex");
}

async function findIdentity(prefix) {
  const result = await run(
    "security",
    ["find-identity", "-v", "-p", "basic"],
    { capture: true },
  ).catch(() => ({ stdout: "" }));
  const match = result.stdout
    .split("\n")
    .map((line) => line.match(/"([^"]+)"/)?.[1])
    .find((identity) => identity?.startsWith(prefix));
  return match ?? null;
}

if (process.platform !== "darwin") {
  throw new Error("The two-app macOS installer must be built on macOS.");
}
if (process.arch !== "arm64") {
  throw new Error("Phase one currently supports Apple Silicon macOS only.");
}

if (!(await exists(obsDmg)) || (await digest(obsDmg)) !== obsDmgSha256) {
  console.log("Preparing the checksum-verified official OBS disk image...");
  await run("node", [join(projectRoot, "scripts", "prepare-obs.mjs"), "macos"]);
}
if ((await digest(obsDmg)) !== obsDmgSha256) {
  throw new Error(`Checksum verification failed for ${obsDmgName}.`);
}

const buildEnvironment = { ...process.env };
buildEnvironment.CARGO_TARGET_DIR = cargoTargetDir;
if (!buildEnvironment.APPLE_SIGNING_IDENTITY) {
  const applicationIdentity = await findIdentity("Developer ID Application:");
  if (applicationIdentity) {
    buildEnvironment.APPLE_SIGNING_IDENTITY = applicationIdentity;
  }
}

if (process.env.STREAMZ_SKIP_BUILD !== "1") {
  await run("pnpm", ["tauri", "build", "--bundles", "app"], {
    env: buildEnvironment,
  });
}
if (!(await exists(appBundle))) {
  throw new Error(`Tauri app bundle was not found at ${appBundle}.`);
}
if (
  await exists(
    join(appBundle, "Contents", "Resources", "resources", "obs"),
  )
) {
  throw new Error(
    "The macOS Streamz bundle still contains OBS. Check tauri.macos.conf.json.",
  );
}

const work = await mkdtemp(join(tmpdir(), "streamz-installer-"));
const mount = join(work, "obs-dmg");
const streamzPayload = join(work, "streamz-payload");
const obsPayload = join(work, "obs-payload");
const streamzComponents = join(work, "streamz-components.plist");
const obsComponents = join(work, "obs-components.plist");
const streamzComponent = join(work, "streamz-component.pkg");
const obsComponent = join(work, "obs-component.pkg");
const distribution = join(work, "Distribution.xml");
let mounted = false;

try {
  await mkdir(mount);
  await run("hdiutil", [
    "attach",
    "-nobrowse",
    "-readonly",
    "-mountpoint",
    mount,
    obsDmg,
  ]);
  mounted = true;

  const officialObs = join(mount, "OBS.app");
  await run("codesign", [
    "--verify",
    "--deep",
    "--strict",
    "--verbose=2",
    officialObs,
  ], { capture: true });

  await mkdir(streamzPayload);
  await mkdir(obsPayload);
  await run("ditto", [
    "--rsrc",
    "--extattr",
    appBundle,
    join(streamzPayload, "Streamz.app"),
  ]);
  await run("ditto", [
    "--rsrc",
    "--extattr",
    officialObs,
    join(obsPayload, "OBS.app"),
  ]);
  await run(
    "codesign",
    [
      "--verify",
      "--deep",
      "--strict",
      "--verbose=2",
      join(obsPayload, "OBS.app"),
    ],
    { capture: true },
  );

  async function createFixedComponentList(payload, destination) {
    await run("pkgbuild", [
      "--analyze",
      "--root",
      payload,
      destination,
    ]);
    const original = await readFile(destination, "utf8");
    const fixed = original
      .replace(
        /(<key>BundleIsRelocatable<\/key>\s*)<true\/>/g,
        "$1<false/>",
      )
      .replace(
        /(<key>BundleIsVersionChecked<\/key>\s*)<true\/>/g,
        "$1<false/>",
      );
    if (
      /<key>BundleIsRelocatable<\/key>\s*<true\/>/.test(fixed)
    ) {
      throw new Error("Could not disable macOS Installer bundle relocation.");
    }
    await writeFile(destination, fixed);
  }

  await createFixedComponentList(streamzPayload, streamzComponents);
  await createFixedComponentList(obsPayload, obsComponents);

  const installerIdentity =
    process.env.APPLE_INSTALLER_SIGNING_IDENTITY ||
    (await findIdentity("Developer ID Installer:"));
  const componentSigning = installerIdentity
    ? ["--sign", installerIdentity]
    : [];

  await run("pkgbuild", [
    "--root",
    streamzPayload,
    "--component-plist",
    streamzComponents,
    "--install-location",
    "/Applications",
    "--identifier",
    "com.besi.streamz.app",
    "--version",
    appVersion,
    ...componentSigning,
    streamzComponent,
  ]);
  await run("pkgbuild", [
    "--root",
    obsPayload,
    "--component-plist",
    obsComponents,
    "--install-location",
    "/Applications",
    "--identifier",
    "com.besi.streamz.obs",
    "--version",
    obsVersion,
    ...componentSigning,
    obsComponent,
  ]);

  await writeFile(
    distribution,
    `<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="2">
  <title>Streamz</title>
  <organization>com.besi.streamz</organization>
  <options customize="never" require-scripts="false" hostArchitectures="arm64"/>
  <domains enable_anywhere="false" enable_currentUserHome="false" enable_localSystem="true"/>
  <choices-outline>
    <line choice="default">
      <line choice="streamz"/>
      <line choice="obs"/>
    </line>
  </choices-outline>
  <choice id="default"/>
  <choice id="streamz" visible="false">
    <pkg-ref id="com.besi.streamz.app"/>
  </choice>
  <choice id="obs" visible="false">
    <pkg-ref id="com.besi.streamz.obs"/>
  </choice>
  <pkg-ref id="com.besi.streamz.app" version="${appVersion}" onConclusion="none">streamz-component.pkg</pkg-ref>
  <pkg-ref id="com.besi.streamz.obs" version="${obsVersion}" onConclusion="none">obs-component.pkg</pkg-ref>
</installer-gui-script>
`,
  );

  await mkdir(outputDir, { recursive: true });
  await rm(outputPackage, { force: true });
  const productSigning = installerIdentity
    ? ["--sign", installerIdentity]
    : [];
  await run("productbuild", [
    "--distribution",
    distribution,
    "--package-path",
    work,
    ...productSigning,
    outputPackage,
  ]);

  const audit = join(work, "package-audit");
  await run("pkgutil", ["--expand-full", outputPackage, audit]);
  for (const component of ["streamz-component.pkg", "obs-component.pkg"]) {
    const packageInfo = await readFile(
      join(audit, component, "PackageInfo"),
      "utf8",
    );
    if (packageInfo.includes("<relocate>")) {
      throw new Error(`${component} still permits bundle relocation.`);
    }
  }
  await run(
    "codesign",
    [
      "--verify",
      "--deep",
      "--strict",
      "--verbose=2",
      join(audit, "obs-component.pkg", "Payload", "OBS.app"),
    ],
    { capture: true },
  );
  await run("pkgutil", ["--check-signature", outputPackage]).catch(() => {});

  const notaryProfile = process.env.STREAMZ_NOTARY_PROFILE;
  if (notaryProfile) {
    if (!installerIdentity) {
      throw new Error("Notarization requires a signed installer package.");
    }
    await run("xcrun", [
      "notarytool",
      "submit",
      outputPackage,
      "--keychain-profile",
      notaryProfile,
      "--wait",
    ]);
    await run("xcrun", ["stapler", "staple", outputPackage]);
  }

  console.log(`\nTwo-app installer created:\n${outputPackage}`);
  if (!installerIdentity) {
    console.log(
      "\nLocal test package only: no Developer ID Installer identity was found.",
    );
  }
} finally {
  if (mounted) {
    await run("hdiutil", ["detach", mount]).catch(() => {});
  }
  await rm(work, { recursive: true, force: true });
}
