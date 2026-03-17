// TaskClassifier — enhanced classification with weighted keyword scoring,
// bigram matching, and content-aware heuristics.

// Weighted keywords: [keyword, weight]
const ROUTINE_KEYWORDS = [
  ["summarize", 2], ["summary", 2], ["format", 1.5], ["extract", 1.5],
  ["parse", 1.5], ["tag", 1], ["categorize", 1.5], ["classify", 1],
  ["template", 1], ["fill", 1], ["translate", 1.5], ["convert", 1.5],
  ["transform", 1], ["filter", 1], ["metadata", 1], ["csv", 1.5],
  ["json", 1], ["status report", 2], ["simple", 1], ["list", 0.5],
  ["count", 0.5], ["sort", 0.5], ["merge", 1], ["deduplicate", 1.5],
  ["spell check", 1.5], ["grammar", 1.5], ["email summary", 2],
  ["meeting notes", 2], ["log parse", 2], ["data clean", 1.5],
  ["reformat", 1.5], ["normalize", 1], ["flatten", 1], ["aggregate", 1],
  ["boilerplate", 1.5], ["lookup", 1], ["regex", 1.5], ["replace", 1],
];

const IMPORTANT_KEYWORDS = [
  ["architect", 3], ["design", 2], ["strategy", 2.5], ["analyze", 2],
  ["debug", 2.5], ["optimize", 2], ["review", 1.5], ["security", 3],
  ["audit", 2.5], ["complex", 1.5], ["research", 2], ["insight", 1.5],
  ["decision", 2], ["plan", 1.5], ["refactor", 2], ["performance", 2],
  ["scale", 2], ["financial", 2], ["creative", 1.5], ["original", 1.5],
  ["novel", 1.5], ["innovate", 2], ["troubleshoot", 2],
  ["root cause", 3], ["system design", 3], ["trade-off", 2],
  ["evaluate", 1.5], ["multi-step", 2], ["reasoning", 2],
  ["deep dive", 2], ["critical", 2], ["vulnerable", 2.5],
  ["exploit", 2.5], ["compliance", 2], ["migration", 2],
];

// Rough token estimation: ~4 chars per token for English
function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export class TaskClassifier {
  /**
   * Classify a task with weighted scoring.
   * @param {object} task - { description, content, hasImage, priority }
   * @returns {object} classification result
   */
  classify(task) {
    const text = `${task.description || ""} ${task.content || ""}`.toLowerCase();
    const inputTokens = estimateTokens(task.content || task.description || "");
    const hasImage = Boolean(task.hasImage);

    const routineScore = this._weightedScore(text, ROUTINE_KEYWORDS);
    const importantScore = this._weightedScore(text, IMPORTANT_KEYWORDS);

    // Manual override via priority field
    if (task.priority === "high" || task.priority === "critical") {
      return this._result("IMPORTANT", task.priority === "critical" ? "very_high" : "high",
        inputTokens, hasImage, importantScore, routineScore);
    }
    if (task.priority === "low") {
      return this._result("ROUTINE", "low", inputTokens, hasImage, routineScore, importantScore);
    }

    // Score-based classification with hysteresis (prevent flipping on small differences)
    let classification;
    let complexity;
    const scoreDiff = importantScore - routineScore;

    if (scoreDiff >= 2) {
      classification = "IMPORTANT";
      complexity = importantScore >= 6 ? "very_high" : importantScore >= 4 ? "high" : "medium_high";
    } else if (scoreDiff >= 0.5) {
      // Slight lean toward important — use medium tier
      classification = "IMPORTANT";
      complexity = "medium";
    } else if (routineScore > importantScore + 0.5) {
      classification = "ROUTINE";
      complexity = routineScore >= 4 ? "medium" : routineScore >= 2 ? "low_medium" : "low";
    } else if (importantScore >= 1) {
      // Ambiguous — lean toward important for quality
      classification = "IMPORTANT";
      complexity = "medium";
    } else {
      // No signals — default to routine (cost-saving)
      classification = "ROUTINE";
      complexity = "low";
    }

    // Large input heuristic: more tokens likely means more complexity
    if (inputTokens > 10000) {
      if (classification === "ROUTINE") complexity = "medium_high";
      if (classification === "IMPORTANT" && complexity === "medium") complexity = "high";
    } else if (inputTokens > 5000 && classification === "ROUTINE") {
      complexity = "medium_high";
    }

    // Code detection heuristic: code snippets usually need better models
    if (this._looksLikeCode(text) && classification === "ROUTINE") {
      complexity = complexity === "low" ? "medium" : "medium_high";
    }

    return this._result(classification, complexity, inputTokens, hasImage, routineScore, importantScore);
  }

  _weightedScore(text, keywords) {
    let score = 0;
    for (const [kw, weight] of keywords) {
      if (text.includes(kw)) score += weight;
    }
    return score;
  }

  _looksLikeCode(text) {
    // Simple heuristic: check for common code patterns
    const codePatterns = [
      /function\s+\w+/, /const\s+\w+\s*=/, /import\s+\{/,
      /class\s+\w+/, /def\s+\w+/, /=>/, /\{\s*\n/,
      /```/, /\bif\s*\(/, /\breturn\b/,
    ];
    let matches = 0;
    for (const pat of codePatterns) {
      if (pat.test(text)) matches++;
    }
    return matches >= 3;
  }

  _result(classification, complexity, inputTokens, hasImage, primaryScore, secondaryScore) {
    return {
      classification,
      complexity,
      inputTokens,
      hasImage,
      scores: { primary: primaryScore, secondary: secondaryScore },
      capabilities: this._requiredCapabilities(hasImage, complexity),
    };
  }

  _requiredCapabilities(hasImage, complexity) {
    const caps = ["text"];
    if (hasImage) caps.push("vision");
    if (["high", "very_high"].includes(complexity)) caps.push("reasoning");
    return caps;
  }
}
