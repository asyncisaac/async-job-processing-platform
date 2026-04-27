import "dotenv/config";
import { spawnSync } from "node:child_process";

const res = spawnSync("npx prisma migrate deploy", {
  stdio: "inherit",
  shell: true,
  env: process.env
});

process.exit(res.status ?? 1);

