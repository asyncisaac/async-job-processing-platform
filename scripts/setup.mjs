import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const envPath = path.join(root, ".env");
const envExamplePath = path.join(root, ".env.example");

function parseEnvFile(content) {
  const lines = content.split(/\r?\n/);
  const map = new Map();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const k = trimmed.slice(0, idx).trim();
    const v = trimmed.slice(idx + 1);
    map.set(k, v);
  }
  return map;
}

if (fs.existsSync(envExamplePath)) {
  if (!fs.existsSync(envPath)) {
    fs.copyFileSync(envExamplePath, envPath);
  } else {
    const example = parseEnvFile(fs.readFileSync(envExamplePath, "utf8"));
    const existing = parseEnvFile(fs.readFileSync(envPath, "utf8"));
    const missing = [];
    for (const [k, v] of example.entries()) {
      if (!existing.has(k)) missing.push([k, v]);
    }
    if (missing.length > 0) {
      const suffix = "\n" + missing.map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
      fs.appendFileSync(envPath, suffix);
    }
  }
}

function run(cmd) {
  const res = spawnSync(cmd, {
    stdio: "inherit",
    shell: true,
    env: process.env
  });
  if (res.status !== 0) process.exit(res.status ?? 1);
}

run("docker compose up -d");
run("npx prisma generate");
run("npx prisma migrate deploy");
run("node scripts/bootstrap.mjs");

