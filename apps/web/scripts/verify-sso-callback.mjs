import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const appPath = resolve(process.cwd(), "src/App.tsx");
const source = readFileSync(appPath, "utf8");

const checks = [
  {
    name: "固定回调路径常量",
    pattern: /const\s+SSO_REDIRECT_PATH\s*=\s*"\/auth\/callback"/
  },
  {
    name: "仅在固定回调路径或根路径兜底处理 code/state",
    pattern: /isPrimaryCallbackPath[\s\S]*isRootFallbackCallbackPath/
  },
  {
    name: "state 一致性校验",
    pattern: /expectedState\s*!==\s*state/
  }
];

const failures = checks.filter((item) => !item.pattern.test(source));

if (failures.length > 0) {
  for (const item of failures) {
    console.error(`[verify:sso-callback] missing check: ${item.name}`);
  }
  process.exit(1);
}

console.log("[verify:sso-callback] ok");
