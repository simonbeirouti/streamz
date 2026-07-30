import { createHash } from "node:crypto";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const version = "32.2.1";
const releaseBase =
  `https://github.com/obsproject/obs-studio/releases/download/${version}`;
const projectRoot = resolve(import.meta.dirname, "..");
const cacheDir = join(projectRoot, ".obs-cache", version);
const stageRoot = join(projectRoot, "src-tauri", "resources", "obs");

const assets = {
  macos: {
    filename: `OBS-Studio-${version}-macOS-Apple.dmg`,
    sha256: "6120c995614be17ecd0ee0877514a88b121249e6261cde46d1440b87d7ffd70c",
  },
  windows: {
    filename: `OBS-Studio-${version}-Windows-x64.zip`,
    sha256: "db64a2934f8261f85b1410b84be011207a0afda5400d008289f1f1e211bcc7de",
  },
  source: {
    filename: `OBS-Studio-${version}-Sources.tar.gz`,
    sha256: "6a2532b1094bc51bc2fdeb1068d5c19cfe04216191a5b35c8707625401a80bf4",
  },
};

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

async function download(asset) {
  await mkdir(cacheDir, { recursive: true });
  const destination = join(cacheDir, asset.filename);
  if ((await exists(destination)) && (await digest(destination)) === asset.sha256) {
    console.log(`Verified cached ${asset.filename}`);
    return destination;
  }

  const response = await fetch(`${releaseBase}/${asset.filename}`, {
    redirect: "follow",
    headers: { "User-Agent": "streamz-obs-preparer" },
  });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed (${response.status}) for ${asset.filename}`);
  }

  const partial = `${destination}.partial`;
  const partialFile = await open(partial, "w");
  await pipeline(Readable.fromWeb(response.body), partialFile.createWriteStream());
  const actual = await digest(partial);
  if (actual !== asset.sha256) {
    await rm(partial, { force: true });
    throw new Error(
      `Checksum mismatch for ${asset.filename}\nexpected ${asset.sha256}\nactual   ${actual}`,
    );
  }
  await rm(destination, { force: true });
  await rename(partial, destination);
  console.log(`Downloaded and verified ${asset.filename}`);
  return destination;
}

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} exited with status ${code}`));
    });
  });
}

async function writePrepared(platform, asset) {
  await mkdir(stageRoot, { recursive: true });
  const metadataPath = join(stageRoot, "prepared.json");
  let metadata = { version, assets: {} };
  if (await exists(metadataPath)) {
    metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  }
  metadata.version = version;
  metadata.assets[platform] = {
    filename: basename(asset.filename),
    sha256: asset.sha256,
    preparedAt: new Date().toISOString(),
  };
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
}

async function isPrepared(platform, asset) {
  const metadataPath = join(stageRoot, "prepared.json");
  const executable =
    platform === "macos"
      ? join(stageRoot, "macos", "OBS.app", "Contents", "MacOS", "OBS")
      : join(stageRoot, "windows", "bin", "64bit", "obs64.exe");
  if (!(await exists(metadataPath)) || !(await exists(executable))) return false;
  try {
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    return (
      metadata.version === version &&
      metadata.assets?.[platform]?.sha256 === asset.sha256
    );
  } catch {
    return false;
  }
}

async function stageMacos() {
  if (process.platform !== "darwin") {
    throw new Error("The signed macOS OBS app can only be extracted on macOS.");
  }
  const dmg = await download(assets.macos);
  const work = await mkdtemp(join(tmpdir(), "streamz-obs-"));
  const mount = join(work, "mount");
  const destination = join(stageRoot, "macos", "OBS.app");
  await mkdir(mount);
  await run("hdiutil", ["attach", "-nobrowse", "-readonly", "-mountpoint", mount, dmg]);
  try {
    await rm(destination, { recursive: true, force: true });
    await mkdir(join(stageRoot, "macos"), { recursive: true });
    await run("ditto", [join(mount, "OBS.app"), destination]);
  } finally {
    await run("hdiutil", ["detach", mount]);
    await rm(work, { recursive: true, force: true });
  }
  await writePrepared("macos", assets.macos);
}

async function stageWindows() {
  const zip = await download(assets.windows);
  const destination = join(stageRoot, "windows");
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });

  if (process.platform === "win32") {
    await run("powershell", [
      "-NoProfile",
      "-Command",
      `Expand-Archive -LiteralPath '${zip.replaceAll("'", "''")}' -DestinationPath '${destination.replaceAll("'", "''")}' -Force`,
    ]);
  } else if (process.platform === "darwin") {
    await run("ditto", ["-x", "-k", zip, destination]);
  } else {
    await run("unzip", ["-q", zip, "-d", destination]);
  }

  const nested = join(destination, `OBS-Studio-${version}`);
  if (await exists(nested)) {
    const temporary = `${destination}-flat`;
    await rm(temporary, { recursive: true, force: true });
    await cp(nested, temporary, { recursive: true });
    await rm(destination, { recursive: true, force: true });
    await rename(temporary, destination);
  }
  await writePrepared("windows", assets.windows);
}

const requested = process.argv[2] ?? "current";
const target =
  requested === "current"
    ? process.platform === "darwin"
      ? "macos"
      : process.platform === "win32"
        ? "windows"
        : ""
    : requested;

const targetAsset = target === "macos" ? assets.macos : assets.windows;
if (
  process.argv.includes("--ensure") &&
  (await isPrepared(target, targetAsset))
) {
  console.log(`OBS ${version} ${target} is ready.`);
  process.exit(0);
}

if (target === "macos") await stageMacos();
else if (target === "windows") await stageWindows();
else throw new Error(`Unsupported OBS preparation target: ${requested}`);

if (process.argv.includes("--with-source")) {
  const source = await download(assets.source);
  console.log(`Corresponding source retained at ${source}`);
}

console.log(`OBS ${version} ${target} is staged for Streamz.`);
