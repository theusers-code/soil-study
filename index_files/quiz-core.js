(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.QuizCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  function normalize(value) {
    return String(value).normalize("NFKD").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
  }
  function shuffle(items, random = Math.random) {
    const result = [...items];
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }
  function isChoiceQuestion(question) {
    return question.type === "objective" || question.type === "truefalse";
  }
  function typeLabel(type) {
    return type === "truefalse" ? "true/false" : type === "fill" ? "fill-in" : type;
  }
  function planSet(bank, preferred = { objective: 6, truefalse: 4, fill: 6, subjective: 4 }) {
    const uniqueBank = [...new Map(bank.map(q => [q.id, q])).values()];
    const available = Object.fromEntries(Object.keys(preferred).map(type => [type, uniqueBank.filter(q => q.type === type).length]));
    const count = Math.min(Object.values(preferred).reduce((sum, n) => sum + n, 0), Object.values(available).reduce((sum, n) => sum + n, 0));
    const quotas = Object.fromEntries(Object.entries(preferred).map(([type, n]) => [type, Math.min(n, available[type])]));
    let remaining = count - Object.values(quotas).reduce((sum, n) => sum + n, 0);
    while (remaining > 0) {
      for (const type of Object.keys(quotas)) {
        if (remaining && quotas[type] < available[type]) { quotas[type]++; remaining--; }
      }
    }
    return { count, quotas };
  }
  function buildSet(bank, quotas, usedIds = [], previousIds = [], random = Math.random) {
    const used = new Set(usedIds), previous = new Set(previousIds), selected = [];
    const uniqueBank = [...new Map(bank.map(q => [q.id, q])).values()];
    for (const [type, count] of Object.entries(quotas)) {
      if (!count) continue;
      const pool = uniqueBank.filter(q => q.type === type);
      if (pool.length < count) throw new Error(`This selection needs ${count} ${type} questions; only ${pool.length} are available. Choose all topics or add more resources.`);
      const fresh = shuffle(pool.filter(q => !used.has(q.id) && !previous.has(q.id)), random);
      const recycled = shuffle(pool.filter(q => used.has(q.id) && !previous.has(q.id)), random);
      const lastResort = shuffle(pool.filter(q => previous.has(q.id)), random);
      const groups = new Set(selected.map(q => q.groupId || q.id));
      const chosen = [];
      // Exhaust unseen questions before recycling, even if avoiding related facts
      // would otherwise require an older question. Prefer varied facts per phase.
      for (const candidates of [fresh, recycled, lastResort]) {
        for (const distinctFacts of [true, false]) {
          for (const question of candidates) {
            if (chosen.length === count) break;
            const group = question.groupId || question.id;
            if (chosen.some(q => q.id === question.id) || (distinctFacts && groups.has(group))) continue;
            chosen.push(question); groups.add(group);
          }
          if (chosen.length === count) break;
        }
        if (chosen.length === count) break;
      }
      selected.push(...chosen);
    }
    const set = shuffle(selected, random).map(q => {
      const choices = isChoiceQuestion(q) ? q.choices.map((text, index) => ({ text, isCorrect: index === q.correctIndex })) : [];
      return { ...q, shuffledChoices: q.type === "objective" ? shuffle(choices, random) : choices };
    });
    return { questions: set, usedIds: [...new Set([...used, ...set.map(q => q.id)])], previousIds: set.map(q => q.id),
      repeated: set.filter(q => previous.has(q.id)).length };
  }
  function gradeFill(answer, acceptedAnswers) {
    const numeric = value => {
      const text = String(value).trim().replace(/\s*[×x*]\s*10\s*\^\s*([+-]?\d+)/gi, 'e$1');
      const match = text.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s*(.*)$/i);
      return match ? { value: Number(match[1]), unit: normalize(match[2]) } : null;
    };
    return acceptedAnswers.some(accepted => {
      const expected = numeric(accepted), actual = numeric(answer);
      if (expected || actual) return Boolean(expected && actual && expected.value === actual.value && expected.unit === actual.unit);
      return normalize(answer) === normalize(accepted);
    });
  }
  function keywordGrade(answer, question) {
    const padded = ` ${normalize(answer)} `;
    return question.requiredTerms.filter(term => padded.includes(` ${normalize(term)} `)).length >= question.minTerms;
  }
  return { normalize, shuffle, planSet, buildSet, gradeFill, keywordGrade, isChoiceQuestion, typeLabel };
});
