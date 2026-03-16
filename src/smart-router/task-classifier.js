// TaskClassifier — determines if a task is ROUTINE or IMPORTANT
// and estimates complexity, token count, and required capabilities.

const ROUTINE_KEYWORDS = [
  "summarize", "summary", "format", "extract", "parse", "tag",
  "categorize", "classify", "template", "fill", "translate",
  "convert", "transform", "filter", "metadata", "csv", "json",
  "status report", "simple", "list", "count", "sort", "merge",
  "deduplicate", "validate format", "spell check", "grammar",
  "email summary", "meeting notes", "log parse", "data clean",
  "reformat", "normalize", "flatten", "aggregate basic",
];

const IMPORTANT_KEYWORDS = [
  "architect", "design", "strategy", "analyze", "debug",
  "optimize", "review", "security", "audit", "complex",
  "research", "insight", "decision", "plan", "model",
  "refactor", "performance", "scale", "financial",
  "creative", "original", "novel", "innovate", "troubleshoot",
  "root cause", "system design", "trade-off", "evaluate",
  "multi-step", "reasoning", "deep dive", "critical",
];

// Rough token estimation: ~4 chars per token for English text
function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export class TaskClassifier {
  /**
   * Classify a task and return routing metadata.
   * @param {object} task - { description: string, content: string, hasImage?: boolean, priority?: string }
   * @returns {object} classification result
   */
  classify(task) {
    const text = `${task.description || ""} ${task.content || ""}`.toLowerCase();
    const inputTokens = estimateTokens(task.content || task.description || "");
    const hasImage = Boolean(task.hasImage);

    const routineScore = this._score(text, ROUTINE_KEYWORDS);
    const importantScore = this._score(text, IMPORTANT_KEYWORDS);

    // Manual override via priority field
    if (task.priority === "high" || task.priority === "critical") {
      return this._result("IMPORTANT", "high", inputTokens, hasImage, importantScore, routineScore);
    }
    if (task.priority === "low") {
      return this._result("ROUTINE", "low", inputTokens, hasImage, routineScore, importantScore);
    }

    // Score-based classification
    let classification;
    let complexity;

    if (importantScore > routineScore && importantScore >= 2) {
      classification = "IMPORTANT";
      complexity = importantScore >= 4 ? "very_high" : "high";
    } else if (routineScore > importantScore) {
      classification = "ROUTINE";
      complexity = routineScore >= 3 ? "medium" : "low";
    } else if (importantScore >= 1) {
      // Tie or ambiguous — lean toward important for safety
      classification = "IMPORTANT";
      complexity = "medium";
    } else {
      // No strong signals — default to routine (cost-saving)
      classification = "ROUTINE";
      complexity = "low";
    }

    // Large input with no clear signal → likely needs a stronger model
    if (inputTokens > 5000 && classification === "ROUTINE") {
      complexity = "medium_high";
    }

    return this._result(classification, complexity, inputTokens, hasImage, routineScore, importantScore);
  }

  _score(text, keywords) {
    let score = 0;
    for (const kw of keywords) {
      if (text.includes(kw)) score++;
    }
    return score;
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
