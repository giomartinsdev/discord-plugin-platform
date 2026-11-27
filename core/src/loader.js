import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, cpSync, rmSync } from "node:fs";
import { join, resolve, basename, dirname, extname } from "node:path";
import { execFileSync } from "node:child_process";
import { parseToml, normalizeManifest } from "./manifest.js";

export const LANG_BY_EXT = {
  ".py": "python", ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".ts": "typescript", ".go": "go", ".rs": "rust", ".rb": "ruby", ".php": "php",
  ".cs": "csharp", ".java": "java", ".kt": "kotlin", ".ex": "elixir", ".lua": "lua",
  ".sh": "shell", ".pl": "perl", ".dart": "dart", ".swift": "swift", ".zig": "zig",
};

export function readManifestFromDir(dir) {
  const file = join(dir, "plugin.toml");
  if (!existsSync(file)) {
    const err = new Error(`plugin.toml não encontrado em ${dir}`);
    err.code = "E_MANIFEST";
    throw err;
  }
  const manifest = normalizeManifest(parseToml(readFileSync(file, "utf8")), file);
  return manifest;
}

export function detectLang(dir, manifest) {
  if (manifest?.lang && manifest.lang !== "unknown") return manifest.lang;
  const entry = manifest?.runtime?.cmd?.[1];
  if (entry) {
    const ext = extname(entry);
    if (LANG_BY_EXT[ext]) return LANG_BY_EXT[ext];
  }
  const files = safeReaddir(dir);
  for (const f of files) {
    const hit = LANG_BY_EXT[extname(f)];
    if (hit) return hit;
  }
  return "unknown";
}

export function findCommit(dir) {
  try {
    return execFileSync("git", ["-C", dir, "rev-parse", "--short=7", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

export function findRepoUrl(dir) {
  try {
    const url = execFileSync("git", ["-C", dir, "config", "--get", "remote.origin.url"], { encoding: "utf8" }).trim();
    return url || null;
  } catch {
    return null;
  }
}

export function findBranch(dir) {
  try {
    return execFileSync("git", ["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "main";
  }
}

/**
 * Instala a partir de um diretório local. Roda o build declarado (se houver)
 * e valida o manifesto. Devolve o pacote pronto para o core registrar.
 */
export function loadLocalPackage(dir, { store, build = true, onLog = () => {} } = {}) {
  const root = resolve(dir);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    const err = new Error(`diretório não encontrado: ${root}`);
    err.code = "E_NOT_FOUND";
    throw err;
  }

  const manifest = readManifestFromDir(root);
  const installDir = join(store ?? root, ".plugins", manifest.id);

  let pkgDir = root;
  if (store && resolve(store) !== root) {
    rmSync(installDir, { recursive: true, force: true });
    mkdirSync(installDir, { recursive: true });
    cpSync(root, installDir, {
      recursive: true,
      filter: (src) => !/[\\/](\.git|node_modules|__pycache__|\.venv|target|dist[\\/]cache)([\\/]|$)/.test(src),
    });
    pkgDir = installDir;
  }

  if (build && manifest.runtime.build && Array.isArray(manifest.runtime.build) && manifest.runtime.build.length) {
    onLog(`$ ${manifest.runtime.build.join(" ")}`);
    const [cmd, ...args] = manifest.runtime.build;
    execFileSync(cmd, args, { cwd: pkgDir, stdio: "pipe", timeout: 240000 });
    onLog("build concluído");
  }

  const entryCandidate = manifest.runtime.cmd[1];
  if (entryCandidate && !existsSync(join(pkgDir, manifest.runtime.cmd[0] === "python3" || manifest.runtime.cmd[0] === "python" ? pkgDir : pkgDir, entryCandidate))) {
    // entry pode ser resolvido pelo interpretador; só avisa
    onLog(`aviso: entrada "${entryCandidate}" não encontrada como arquivo`);
  }

  return {
    manifest,
    dir: pkgDir,
    lang: detectLang(root, manifest),
    commitSha: findCommit(root),
    repoUrl: findRepoUrl(root),
    branch: findBranch(root),
    runtime: {
      ...manifest.runtime,
      cmd: manifest.runtime.cmd,
      cwd: pkgDir,
    },
  };
}

function safeReaddir(dir) {
  try { return readdirSync(dir); } catch { return []; }
}

/* ── git ── */

/** "https://github.com/u/repo.git" ou "git@github.com:u/repo" → "repo" */
export function slugFromUrl(url) {
  const tail = String(url).replace(/\/+$/, "").split(/[/:]/).pop() ?? "plugin";
  return tail.replace(/\.git$/, "").replace(/[^\w.-]/g, "-") || "plugin";
}

export function isRepoUrl(value) {
  return /^(https?:\/\/|git@|ssh:\/\/|git:\/\/|file:\/\/)/.test(String(value).trim());
}

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", timeout: 120000, stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * Clona o repositório num diretório de trabalho dentro do core. O id do plugin
 * ainda não é conhecido, então o destino vem do nome do repositório.
 * Devolve o diretório do clone (que contém plugin.toml).
 */
export function cloneRepo(url, { workDir, branch, onLog = () => {} }) {
  const dest = join(workDir, "_src", slugFromUrl(url));
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dirname(dest), { recursive: true });

  const args = ["clone", "--depth", "1"];
  if (branch) args.push("--branch", branch);
  args.push(url, dest);
  onLog(`$ git ${args.join(" ")}`);
  try {
    git(args);
  } catch (err) {
    const detail = String(err.stderr || err.message).trim().split("\n").slice(-2).join(" ");
    const e = new Error(`falha ao clonar ${url}: ${detail}`);
    e.code = "E_CLONE";
    throw e;
  }
  return dest;
}

/**
 * Puxa commits novos num clone existente. Usa fetch+reset em vez de pull para
 * não depender de estado local (o diretório é descartável).
 */
export function pullRepo(dir, { branch, onLog = () => {} }) {
  const ref = branch || "HEAD";
  onLog(`$ git fetch --depth 1 origin ${ref}`);
  try {
    git(["fetch", "--depth", "1", "origin", ref], dir);
    git(["reset", "--hard", "FETCH_HEAD"], dir);
  } catch (err) {
    const detail = String(err.stderr || err.message).trim().split("\n").slice(-2).join(" ");
    const e = new Error(`falha ao atualizar ${dir}: ${detail}`);
    e.code = "E_PULL";
    throw e;
  }
  return findCommit(dir);
}

export function pluginSummary(pkg, store, defaultGuilds = []) {
  return {
    id: pkg.manifest.id,
    name: pkg.manifest.name,
    version: pkg.manifest.version,
    description: pkg.manifest.description,
    repoUrl: pkg.repoUrl,
    branch: pkg.branch,
    commitSha: pkg.commitSha,
    lang: pkg.lang,
    runtime: pkg.runtime,
    manifest: pkg.manifest.raw,
    capabilityList: pkg.manifest.capabilities,
    commands: pkg.manifest.commands,
    events: pkg.manifest.events,
  };
}
