// Smoke test for semantic-consistency-guard.ts
// Tests against the real-world drift scenario that motivated this guard

function jaccardSimilarity(a, b) {
  const tokenize = (t) => [...new Set(t.toLowerCase()
    .split(/[\s,，。；：、()（）\[\]【】]+/)
    .filter(x => x.length >= 2))];
  const A = tokenize(a), B = tokenize(b);
  if (A.length === 0 || B.length === 0) return 0;
  const inter = A.filter(x => B.includes(x));
  return inter.length / (new Set([...A, ...B])).size;
}

// ── Test Case 1: Real scenario from chat ──

const userDef1 = "graphify 源码拉到 github 目录，用 github conda 环境管理依赖，跟 robotassistant 完全分离，不同项目各自独立跑 graphify";
const userDef2 = "graphify 直接嵌入到 robotassistant 项目里，跟 robotassistant 绑在一起";

const agentDef1_drifted = "装 uv tool install graphify 全局跑，像 pip 包一样用";
const agentDef1_correct = "graphify 放 github conda 环境，跟 robotassistant 分开独立";
const agentDef2_drifted = "每个项目都装一份 graphify 源码";
const agentDef2_correct = "graphify 直接嵌入到 robotassistant 里绑在一起";

console.log("=== Test 1: Real drift scenario ===");
const t1d = jaccardSimilarity(agentDef1_drifted, userDef1);
const t1c = jaccardSimilarity(agentDef1_correct, userDef1);
console.log("方案一 drifted:", t1d.toFixed(2), t1d < 0.3 ? "DETECTED ✓" : "MISSED ✗");
console.log("方案一 correct:", t1c.toFixed(2), t1c >= 0.3 ? "PASSED ✓" : "FALSE_POSITIVE ✗");

const t2d = jaccardSimilarity(agentDef2_drifted, userDef2);
const t2c = jaccardSimilarity(agentDef2_correct, userDef2);
console.log("方案二 drifted:", t2d.toFixed(2), t2d < 0.3 ? "DETECTED ✓" : "MISSED ✗");
console.log("方案二 correct:", t2c.toFixed(2), t2c >= 0.3 ? "PASSED ✓" : "FALSE_POSITIVE ✗");

// ── Test Case 2: Pattern detection ──

const CONTRAST_PATTERNS = [
  /方案([一二三四五六])/g,
  /选项([A-E一二三四五1-5])/g,
  /(?:方式|方法)([一二三四五1-5])/g,
  /(?:Option|Approach|Method|Plan)\s+([A-C1-5])/gi,
];

function hasContrastStructure(text) {
  for (const regex of CONTRAST_PATTERNS) {
    regex.lastIndex = 0;
    if (regex.test(text)) return true;
  }
  return false;
}

console.log("\n=== Test 2: Pattern detection ===");
const testCases = [
  ["方案一和方案二", true],
  ["今天天气不错", false],
  ["选项A和其他选项", true],
  ["代码 review 意见", false],
  ["Approach A vs Approach B", true],
  ["hello world", false],
];

for (const [text, expected] of testCases) {
  const result = hasContrastStructure(text);
  const status = result === expected ? "✓" : "✗";
  console.log(`  ${status} "${text}": ${result} (expected ${expected})`);
}

// ── Summary ──
const allPassed = t1d < 0.3 && t1c >= 0.3 && t2d < 0.3 && t2c >= 0.3;
console.log("\n=== Summary ===");
console.log(allPassed ? "ALL TESTS PASSED ✓" : "SOME TESTS FAILED - adjust threshold");
