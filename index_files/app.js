(function () {
  "use strict";

  const QUESTION_QUOTAS = { objective: 6, truefalse: 4, fill: 6, subjective: 4 };
  const QUESTION_STORAGE_KEY = "soil-study:imported-questions";
  const BEST_SCORE_KEY = "soil-study:best-score";
  const HISTORY_KEY = "soil-study:history";
  const SHUFFLE_KEY = "soil-study:shuffle-state";
  const builtInQuestions = window.SOIL_QUESTION_BANK;
  const elements = {
    welcome: document.getElementById("welcome-view"),
    quiz: document.getElementById("quiz-view"),
    results: document.getElementById("results-view"),
    start: document.getElementById("start-quiz"),
    replay: document.getElementById("replay-quiz"),
    exit: document.getElementById("exit-quiz"),
    progress: document.querySelector(".progress-track"),
    progressFill: document.getElementById("progress-fill"),
    count: document.getElementById("question-count"),
    type: document.getElementById("question-type"),
    topic: document.getElementById("question-topic"),
    prompt: document.getElementById("question-prompt"),
    answer: document.getElementById("answer-area"),
    feedback: document.getElementById("feedback"),
    submit: document.getElementById("submit-answer"),
    score: document.getElementById("quiz-score"),
    citation: document.getElementById("source-citation"),
    markingNote: document.getElementById("marking-note"),
    finalScore: document.getElementById("final-score"),
    correctCount: document.getElementById("correct-count"),
    incorrectCount: document.getElementById("incorrect-count"),
    bestScore: document.getElementById("best-score"),
    resultsSummary: document.getElementById("results-summary"),
    replayNote: document.getElementById("replay-note"),
    importDialog: document.getElementById("import-dialog"),
    openImport: document.getElementById("open-import"),
    questionFile: document.getElementById("question-file"),
    importStatus: document.getElementById("import-status"),
    storageWarning: document.getElementById("storage-warning"),
  };

  let importedQuestions = [];
  let storageError = "";
  let bestScore = null;
  let library = { topics: [], resources: [], questions: [] };
  let serverAvailable = false;
  let history = [];
  let attempts = [];
  let skippedAnswers = 0;
  let repeatedQuestions = 0;
  let draftResourceId = null;
  let quizQuestions = [];
  let questionIndex = 0;
  let score = 0;
  let correctAnswers = 0;
  let incorrectAnswers = 0;
  let usedQuestionIds = new Set();
  let previousSetIds = new Set();
  let answerLocked = false;
  let activeFocus = "all";

  function focusedQuestions() {
    const focus = document.getElementById("topic-filter").value;
    return allQuestions().filter(q => focus === "all" || q.topic === focus);
  }

  function renderTopicPreview() {
    const bank = focusedQuestions(), plan = QuizCore.planSet(bank, QUESTION_QUOTAS);
    const focus = document.getElementById("topic-filter").value;
    const mix = Object.entries(plan.quotas).filter(([, count]) => count).map(([type, count]) => `${count} ${QuizCore.typeLabel(type)}`).join(", ");
    document.getElementById("set-preview").textContent = `${plan.count} question${plan.count === 1 ? "" : "s"} · ~${Math.max(1, Math.ceil(plan.count * 0.8))} min`;
    document.getElementById("bank-summary").textContent = `${bank.length} ${focus === "all" ? "course" : "topic"} questions · ${mix || "No questions available"}${plan.count ? " per set" : ""}`;
    document.getElementById("topic-note").textContent = !plan.count
      ? "No questions are available yet. Add reviewed questions to start practising."
      : focus === "all" ? "A mixed set from all available course topics."
      : `Only questions on ${focus}.${plan.count < 20 ? ` This topic has ${plan.count} unique question${plan.count === 1 ? "" : "s"}; shorter sets keep each question distinct.` : ""}`;
    elements.start.disabled = plan.count === 0;
  }

  function normalize(value) {
    return String(value)
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function validateQuestion(question, index) {
    const label = `Question ${index + 1}`;
    if (!question || typeof question !== "object" || Array.isArray(question)) {
      throw new Error(`${label} must be an object.`);
    }
    if (typeof question.id !== "string" || !question.id.trim()) {
      throw new Error(`${label} needs a non-empty string id.`);
    }
    if (!["objective", "truefalse", "fill", "subjective"].includes(question.type)) {
      throw new Error(`${label} has an unsupported type.`);
    }
    for (const field of ["prompt", "topic", "source", "explanation"]) {
      if (typeof question[field] !== "string" || !question[field].trim()) {
        throw new Error(`${label} needs a non-empty ${field}.`);
      }
    }

    if (QuizCore.isChoiceQuestion(question)) {
      if (!Array.isArray(question.choices) || question.choices.length < 2 || question.choices.some((choice) => typeof choice !== "string" || !choice.trim())) {
        throw new Error(`${label} needs at least two non-empty choices.`);
      }
      if (!Number.isInteger(question.correctIndex) || question.correctIndex < 0 || question.correctIndex >= question.choices.length) {
        throw new Error(`${label} needs a valid correctIndex.`);
      }
      if (question.type === "truefalse" && (question.choices.length !== 2 || question.choices[0] !== "True" || question.choices[1] !== "False")) {
        throw new Error(`${label} needs choices ["True", "False"].`);
      }
    } else if (question.type === "fill") {
      if (!Array.isArray(question.acceptedAnswers) || question.acceptedAnswers.length === 0 || question.acceptedAnswers.some((answer) => typeof answer !== "string" || !answer.trim())) {
        throw new Error(`${label} needs one or more acceptedAnswers.`);
      }
    } else {
      if (!Array.isArray(question.requiredTerms) || question.requiredTerms.length === 0 || question.requiredTerms.some((term) => typeof term !== "string" || !term.trim())) {
        throw new Error(`${label} needs one or more requiredTerms.`);
      }
      if (!Number.isInteger(question.minTerms) || question.minTerms < 1 || question.minTerms > question.requiredTerms.length) {
        throw new Error(`${label} needs a minTerms value between 1 and the number of requiredTerms.`);
      }
      if (typeof question.sampleAnswer !== "string" || !question.sampleAnswer.trim()) {
        throw new Error(`${label} needs a sampleAnswer.`);
      }
    }
  }

  function validateQuestionList(value) {
    const questions = Array.isArray(value) ? value : value && value.questions;
    if (!Array.isArray(questions) || questions.length === 0) {
      throw new Error("The JSON must contain a non-empty questions array.");
    }
    const seen = new Set();
    questions.forEach((question, index) => {
      validateQuestion(question, index);
      if (seen.has(question.id)) {
        throw new Error(`Duplicate id "${question.id}" in this file.`);
      }
      seen.add(question.id);
    });
    return questions;
  }

  function initializeStorage() {
    try {
      const savedQuestions = localStorage.getItem(QUESTION_STORAGE_KEY);
      if (savedQuestions) {
        importedQuestions = validateQuestionList(JSON.parse(savedQuestions));
      }
      history = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
      if (!Array.isArray(history)) history = [];
      history = history.filter(item => item && Number.isFinite(item.score) && Number.isFinite(item.correct) && Number.isFinite(item.incorrect) && !Number.isNaN(new Date(item.date).getTime()));
      const shuffleState = JSON.parse(localStorage.getItem(SHUFFLE_KEY) || "{}");
      usedQuestionIds = new Set(Array.isArray(shuffleState.usedIds) ? shuffleState.usedIds : []);
      previousSetIds = new Set(Array.isArray(shuffleState.previousIds) ? shuffleState.previousIds : []);
      const savedBestScore = localStorage.getItem(BEST_SCORE_KEY);
      if (savedBestScore !== null) {
        const parsedScore = Number(savedBestScore);
        if (!Number.isFinite(parsedScore)) {
          throw new Error("The saved personal-best score is not a number.");
        }
        bestScore = parsedScore;
      }
    } catch (error) {
      storageError = `This browser could not read saved questions or scores (${error.message}). You can still practise, but saved data may not be available.`;
      importedQuestions = [];
    }
    if (storageError) {
      elements.storageWarning.textContent = storageError;
      elements.storageWarning.hidden = false;
    }
  }

  function allQuestions() {
    const combined = [...builtInQuestions, ...importedQuestions, ...library.questions];
    return [...new Map(combined.filter(withinOutline).map(q => [q.id, q])).values()];
  }

  function withinOutline(question) {
    if (!library.topics.length) return true;
    const text = ` ${normalize(question.topic + " " + question.prompt + " " + question.explanation)} `;
    return library.topics.some(topic => topic.name.toLowerCase() === question.topic.toLowerCase() ||
      topic.keywords.some(keyword => text.includes(` ${normalize(keyword)} `)));
  }

  function shuffle(items) {
    const result = [...items];
    for (let index = result.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(Math.random() * (index + 1));
      [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
    }
    return result;
  }

  function buildQuestionSet() {
    const bank = focusedQuestions(), plan = QuizCore.planSet(bank, QUESTION_QUOTAS);
    if (!plan.count) throw new Error("No questions are available for this topic. Choose another topic or add more resources.");
    const result = QuizCore.buildSet(bank, plan.quotas, [...usedQuestionIds], [...previousSetIds]);
    usedQuestionIds = new Set(result.usedIds);
    previousSetIds = new Set(result.previousIds);
    repeatedQuestions = result.repeated;
    saveLocal(SHUFFLE_KEY, { usedIds: result.usedIds, previousIds: result.previousIds });
    return result.questions;
  }

  function setVisibleView(view) {
    elements.welcome.hidden = view !== "welcome";
    elements.quiz.hidden = view !== "quiz";
    elements.results.hidden = view !== "results";
    document.getElementById("course-dashboard").hidden = view === "quiz";
    elements.openImport.disabled = view === "quiz";
    document.querySelector(".library-link").hidden = view === "quiz";
  }

  function signedScore(value) {
    return value < 0 ? `−${Math.abs(value)}` : `+${value}`;
  }

  function startQuiz() {
    try {
      quizQuestions = buildQuestionSet();
      activeFocus = document.getElementById("topic-filter").value;
      elements.progress.setAttribute("aria-valuemax", String(quizQuestions.length));
    } catch (error) {
      window.alert(error.message);
      return;
    }
    questionIndex = 0;
    score = 0;
    correctAnswers = 0;
    incorrectAnswers = 0;
    skippedAnswers = 0;
    attempts = [];
    setVisibleView("quiz");
    renderQuestion();
  }

  function renderQuestion() {
    const question = quizQuestions[questionIndex];
    answerLocked = false;
    elements.count.innerHTML = `QUESTION ${String(questionIndex + 1).padStart(2, "0")} <span>/ ${quizQuestions.length}</span>`;
    elements.type.textContent = question.type === "truefalse" ? "TRUE / FALSE" : question.type === "fill" ? "FILL IN" : question.type.toUpperCase();
    elements.type.dataset.type = question.type;
    elements.topic.textContent = question.topic.toUpperCase();
    elements.prompt.textContent = question.prompt;
    elements.answer.replaceChildren();
    elements.feedback.hidden = true;
    elements.feedback.classList.remove("is-incorrect");
    elements.feedback.replaceChildren();
    elements.submit.disabled = false;
    elements.submit.textContent = "Check answer";
    document.getElementById("skip-answer").hidden = false;
    elements.progressFill.style.width = `${((questionIndex + 1) / quizQuestions.length) * 100}%`;
    elements.progress.setAttribute("aria-valuenow", String(questionIndex + 1));
    elements.score.innerHTML = `<span>YOUR SCORE</span><strong>${signedScore(score)}</strong>`;
    elements.citation.textContent = `Source: ${question.source}`;
    elements.markingNote.innerHTML = question.type === "subjective"
      ? 'Keyword check <span>·</span> Correct +1 <span>·</span> Incorrect −1'
      : 'Correct +1 <span>·</span> Incorrect −1';

    if (QuizCore.isChoiceQuestion(question)) {
      const options = document.createDocumentFragment();
      question.shuffledChoices.forEach((choice, index) => {
        const label = document.createElement("label");
        label.className = "answer-option";
        const input = document.createElement("input");
        input.type = "radio";
        input.name = "quiz-answer";
        input.value = String(index);
        input.setAttribute("aria-label", choice.text);
        const text = document.createElement("span");
        text.textContent = choice.text;
        label.append(input, text);
        options.append(label);
      });
      elements.answer.append(options);
    } else {
      const input = document.createElement(question.type === "subjective" ? "textarea" : "input");
      input.className = "answer-input";
      input.id = "written-answer";
      input.name = "written-answer";
      input.autocomplete = "off";
      input.placeholder = question.type === "subjective" ? "Write a short response…" : "Type your answer…";
      if (question.type === "fill") {
        input.type = "text";
        input.setAttribute("aria-label", "Your fill-in answer");
      } else {
        input.setAttribute("aria-label", "Your short-answer response");
      }
      elements.answer.append(input);
    }
    elements.prompt.tabIndex = -1;
    elements.prompt.focus({ preventScroll: true });
  }

  function checkAnswer(question) {
    if (QuizCore.isChoiceQuestion(question)) {
      const selected = elements.answer.querySelector('input[name="quiz-answer"]:checked');
      return selected !== null && question.shuffledChoices[Number(selected.value)].isCorrect;
    }
    const answerInput = document.getElementById("written-answer");
    const answer = answerInput.value.trim();
    if (!answer) {
      answerInput.focus();
      showFeedback("Add an answer before checking it.", false, false);
      return null;
    }
    if (question.type === "fill") {
      return QuizCore.gradeFill(answer, question.acceptedAnswers);
    }
    return QuizCore.keywordGrade(answer, question);
  }

  function showFeedback(message, isCorrect, answerWasChecked) {
    elements.feedback.replaceChildren();
    elements.feedback.hidden = false;
    elements.feedback.classList.toggle("is-incorrect", answerWasChecked && !isCorrect);
    if (!answerWasChecked) {
      elements.feedback.textContent = message;
      return;
    }
    const heading = document.createElement("strong");
    heading.textContent = isCorrect ? "Correct · +1 point" : "Not quite · −1 point";
    const detail = document.createElement("span");
    detail.textContent = message;
    elements.feedback.append(heading, detail);
  }

  function feedbackMessage(question, isCorrect) {
    if (QuizCore.isChoiceQuestion(question)) {
      const correctChoice = question.shuffledChoices.find((choice) => choice.isCorrect);
      return isCorrect
        ? question.explanation
        : `${question.explanation} The answer is: ${correctChoice.text}`;
    }
    if (question.type === "fill") {
      const accepted = question.acceptedAnswers[0];
      return isCorrect ? question.explanation : `${question.explanation} An accepted answer is: ${accepted}.`;
    }
    return isCorrect
      ? question.explanation
      : `${question.explanation} Sample answer: ${question.sampleAnswer}`;
  }

  function lockAnswerInputs() {
    for (const input of elements.answer.querySelectorAll("input, textarea")) {
      input.disabled = true;
    }
    for (const option of elements.answer.querySelectorAll(".answer-option")) {
      option.classList.add("is-locked");
    }
  }

  function submitAnswer() {
    const question = quizQuestions[questionIndex];
    if (answerLocked) {
      questionIndex += 1;
      if (questionIndex === quizQuestions.length) {
        finishQuiz();
      } else {
        renderQuestion();
      }
      return;
    }
    const isCorrect = checkAnswer(question);
    if (isCorrect === null) {
      return;
    }
    if (QuizCore.isChoiceQuestion(question) && !elements.answer.querySelector('input[name="quiz-answer"]:checked')) {
      elements.feedback.hidden = false;
      elements.feedback.textContent = "Choose an answer before checking it.";
      return;
    }

    answerLocked = true;
    const selected = elements.answer.querySelector('input[name="quiz-answer"]:checked');
    attempts.push({ question, answer: QuizCore.isChoiceQuestion(question) ? question.shuffledChoices[Number(selected.value)].text : document.getElementById("written-answer").value.trim(), correct: isCorrect, skipped: false });
    lockAnswerInputs();
    document.getElementById("skip-answer").hidden = true;
    if (isCorrect) {
      score += 1;
      correctAnswers += 1;
    } else {
      score -= 1;
      incorrectAnswers += 1;
    }
    elements.score.innerHTML = `<span>YOUR SCORE</span><strong>${signedScore(score)}</strong>`;
    showFeedback(feedbackMessage(question, isCorrect), isCorrect, true);
    if (question.type === "subjective") {
      const rubric = document.createElement("p");
      rubric.className = "rubric-note";
      rubric.textContent = `Automatic keyword check: ${question.minTerms} of these terms needed: ${question.requiredTerms.join(", ")}. Compare your meaning with the sample answer: ${question.sampleAnswer}`;
      const adjust = document.createElement("button");
      adjust.type = "button";
      adjust.className = "text-button";
      adjust.textContent = isCorrect ? "My answer is incorrect · change to −1" : "My answer covers the ideas · change to +1";
      adjust.addEventListener("click", () => {
        const record = attempts[attempts.length - 1];
        record.correct = !isCorrect;
        record.selfMarked = true;
        score += isCorrect ? -2 : 2;
        correctAnswers += isCorrect ? -1 : 1;
        incorrectAnswers += isCorrect ? 1 : -1;
        elements.score.innerHTML = `<span>YOUR SCORE</span><strong>${signedScore(score)}</strong>`;
        showFeedback(`${question.explanation} Self-marked after comparing with the sample answer.`, !isCorrect, true);
      }, { once: true });
      elements.feedback.append(rubric, adjust);
    }
    elements.submit.textContent = questionIndex === quizQuestions.length - 1 ? "See my results" : "Next question";
  }

  function finishQuiz() {
    setVisibleView("results");
    const questionLabel = `${quizQuestions.length} question${quizQuestions.length === 1 ? "" : "s"}`;
    elements.replayNote.textContent = "";
    elements.finalScore.textContent = signedScore(score);
    elements.correctCount.textContent = String(correctAnswers);
    elements.incorrectCount.textContent = String(incorrectAnswers);
    document.getElementById("skipped-count").textContent = String(skippedAnswers);
    document.getElementById("score-breakdown").textContent = `${correctAnswers} correct (+${correctAnswers}) − ${incorrectAnswers} incorrect (−${incorrectAnswers}) + ${skippedAnswers} skipped (0) = ${signedScore(score)} / ${quizQuestions.length}. Scores can be negative.`;
    elements.resultsSummary.textContent = score > 0
      ? `You earned ${signedScore(score)} across ${questionLabel}. Keep building on that knowledge.`
      : score === 0
        ? `You finished ${questionLabel} with a score of +0. Review the explanations and try a new mix.`
        : `You finished ${questionLabel} with a score of ${signedScore(score)}. Review the explanations and try again.`;
    if (activeFocus !== "all") elements.resultsSummary.textContent += ` Topic: ${activeFocus}.`;

    if (bestScore === null || score > bestScore) {
      bestScore = score;
      try {
        localStorage.setItem(BEST_SCORE_KEY, String(bestScore));
      } catch (error) {
        elements.replayNote.textContent = `Your score is ${signedScore(score)}. This browser could not save your personal best (${error.message}).`;
      }
    }
    elements.bestScore.textContent = signedScore(bestScore);
    if (!elements.replayNote.textContent.startsWith("Your score is")) {
      elements.replayNote.textContent = repeatedQuestions ? `${repeatedQuestions} question(s) were reused because this topic has a small bank. Add more resources for greater variety.` : "Your next set uses different questions wherever the bank is large enough, with shuffled answer choices.";
    }
    history.unshift({ date: new Date().toISOString(), score, correct: correctAnswers, incorrect: incorrectAnswers, skipped: skippedAnswers, focus: activeFocus, total: quizQuestions.length });
    history = history.slice(0, 20);
    saveLocal(HISTORY_KEY, history);
    renderHistory();
    renderReview();
    document.getElementById("results-title").tabIndex = -1;
    document.getElementById("results-title").focus({ preventScroll: true });
  }

  function setImportStatus(message, isError) {
    elements.importStatus.textContent = message;
    elements.importStatus.classList.toggle("is-error", isError);
  }

  async function importQuestionFile(file) {
    if (!file) {
      return;
    }
    try {
      if (serverAvailable) {
        await uploadResource(file);
        elements.questionFile.value = "";
        return;
      }
      const imported = validateQuestionList(JSON.parse(await file.text()));
      if (imported.some(q => !withinOutline(q))) throw new Error("Some questions are outside the saved course outline.");
      const currentIds = new Set(allQuestions().map((question) => question.id));
      const duplicate = imported.find((question) => currentIds.has(question.id));
      if (duplicate) {
        throw new Error(`Question id "${duplicate.id}" already exists. Give each question a unique id and try again.`);
      }
      const updatedQuestions = [...importedQuestions, ...imported];
      try {
        localStorage.setItem(QUESTION_STORAGE_KEY, JSON.stringify(updatedQuestions));
      } catch (error) {
        throw new Error(`Questions were not saved because this browser blocked local storage (${error.message}).`);
      }
      importedQuestions = updatedQuestions;
      renderLibrary();
      setImportStatus(`${imported.length} question${imported.length === 1 ? "" : "s"} added. They will be included in future sets on this browser.`, false);
      elements.questionFile.value = "";
    } catch (error) {
      setImportStatus(error.message, true);
      elements.questionFile.value = "";
    }
  }

  function openImportDialog() {
    setImportStatus("", false);
    document.getElementById("draft-preview").hidden = true;
    elements.importDialog.showModal();
  }

  function saveLocal(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); }
    catch { elements.storageWarning.textContent = "Browser storage is unavailable. You can practise, but your history and shuffle progress will not survive a reload."; elements.storageWarning.hidden = false; }
  }

  function renderReview() {
    const list = document.getElementById("review-list");
    list.replaceChildren();
    attempts.forEach((record, index) => {
      const row = document.createElement("details");
      row.className = "review-row";
      const heading = document.createElement("summary");
      heading.textContent = `${String(index + 1).padStart(2, "0")} · ${record.skipped ? "Skipped · 0" : record.correct ? "Correct · +1" : "Incorrect · −1"} · ${record.question.prompt}`;
      const answer = document.createElement("p");
      answer.textContent = `Your answer: ${record.answer || "Skipped"}${record.selfMarked ? " (self-marked)" : ""}`;
      const expected = document.createElement("p");
      const q = record.question;
      expected.textContent = `Answer: ${QuizCore.isChoiceQuestion(q) ? q.choices[q.correctIndex] : q.type === "fill" ? q.acceptedAnswers.join(" / ") : q.sampleAnswer}`;
      const explanation = document.createElement("p");
      explanation.textContent = q.explanation;
      const source = document.createElement("small");
      source.textContent = `Source: ${q.source}`;
      row.append(heading, answer, expected, explanation, source);
      list.append(row);
    });
  }

  function renderHistory() {
    document.getElementById("home-sets-completed").textContent = String(history.length);
    document.getElementById("home-best-score").textContent = bestScore === null ? "—" : signedScore(bestScore);
    const list = document.getElementById("history-list");
    list.replaceChildren();
    if (!history.length) { list.textContent = "Your first set starts the story. Give it a try."; return; }
    history.slice(0, 5).forEach(item => {
      const row = document.createElement("div");
      row.className = "history-row";
      const label = document.createElement("span");
      const date = new Date(item.date);
      label.textContent = `${date.toLocaleDateString(undefined, { day: "numeric", month: "short" })} · ${item.correct} correct, ${item.incorrect} incorrect`;
      if (item.focus && item.focus !== "all") label.textContent += ` · ${item.focus}`;
      const value = document.createElement("strong"); value.textContent = signedScore(item.score);
      row.append(label, value); list.append(row);
    });
  }

  function renderLibrary() {
    const bank = allQuestions(), filter = document.getElementById("topic-filter"), oldValue = filter.value;
    filter.replaceChildren(new Option("All course topics", "all"));
    [...new Set(bank.map(q => q.topic))].sort().forEach(topic => {
      const option = new Option(`${topic} · ${bank.filter(q => q.topic === topic).length} questions`, topic);
      filter.append(option);
    });
    if ([...filter.options].some(o => o.value === oldValue && !o.disabled)) filter.value = oldValue;
    renderTopicPreview();
    const list = document.getElementById("resource-list"); list.replaceChildren();
    document.getElementById("library-status").textContent = library.readOnly
      ? `${library.resources.length} course references · ${library.topics.length} topics · ${bank.length} practice questions`
      : serverAvailable
      ? `${library.resources.length} resources saved · ${library.topics.length} outline topics · ${bank.length} practice questions`
      : "Built-in course bank ready. Start the local server to upload and read resources.";
    library.resources.forEach(resource => {
      const row = document.createElement("div"); row.className = "resource-row";
      const icon = document.createElement("span"); icon.className = "file-kind"; icon.textContent = resource.kind;
      const text = document.createElement("div"), name = document.createElement("strong"), detail = document.createElement("small");
      name.textContent = resource.name.replace(/^#+/, "");
      detail.textContent = resource.status === "reference" ? "Course reference · curated questions in the built-in bank"
        : resource.status === "outside-outline" ? "Reference only · outside this course outline"
        : resource.status === "draft" ? `${resource.questionCount} generated questions · review before use`
        : resource.status === "no-matching-facts" ? "Reference saved · no matching definitions found"
        : `${resource.questionCount} questions available`;
      text.append(name, detail); row.append(icon, text);
      if (resource.status === "draft") {
        const review = document.createElement("button"); review.className = "text-button"; review.type = "button"; review.textContent = "Review";
        review.addEventListener("click", () => { openImportDialog(); showDrafts(resource.id); }); row.append(review);
      } else if (resource.canGenerate) {
        const generate = document.createElement("button"); generate.className = "text-button"; generate.type = "button"; generate.textContent = "Generate";
        generate.addEventListener("click", async () => {
          generate.disabled = true;
          openImportDialog();
          try { library = await api("/api/generate", { resourceId: resource.id }); renderLibrary(); showDrafts(resource.id); setImportStatus("New questions generated. Review the answers and source excerpts below.", false); }
          catch (error) { setImportStatus(error.message, true); generate.disabled = false; }
        }); row.append(generate);
      }
      list.append(row);
    });
    if (!library.resources.length) list.textContent = "Add your lecture notes to grow the bank.";
    renderHistory();
  }

  async function api(path, body) {
    if (body !== undefined && library.readOnly) throw new Error("The hosted course library is read-only. Prepared question banks can be saved in your browser.");
    const response = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "The request could not be completed.");
    return result;
  }

  async function loadLibrary() {
    elements.start.disabled = true;
    try {
      try { library = await api("/api/library"); }
      catch { library = await api("./library.json"); }
      validateQuestionList({ questions: [...builtInQuestions, ...library.questions] });
      serverAvailable = !library.readOnly;
    } catch { serverAvailable = false; }
    renderLibrary();
    if (library.readOnly) {
      elements.openImport.textContent = "Add question bank";
      document.getElementById("import-title").textContent = "Add a question bank";
      document.getElementById("import-description").textContent = "Import a prepared JSON question bank for extra practice. Added questions are saved only in this browser. Lecture uploads and question generation are available in the local desktop version.";
      document.getElementById("local-resource-upload").hidden = true;
      document.getElementById("resource-file").disabled = true;
      document.getElementById("outline-text").readOnly = true;
      document.getElementById("save-outline").hidden = true;
      document.getElementById("outline-help").textContent = "These are the published course topics and keywords. Imported question banks must match this outline.";
    }
  }

  async function uploadResource(file) {
    if (!serverAvailable) throw new Error("Start the local server with python server.py to read study resources.");
    if (file.size > 20_000_000) throw new Error("Each file must be smaller than 20 MB.");
    const content = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(",")[1]); reader.onerror = reject; reader.readAsDataURL(file); });
    setImportStatus(`Reading ${file.name}… Scanned PDFs can take a few minutes.`, false);
    const result = await api("/api/resources", { name: file.name, content });
    library = result.library;
    renderLibrary();
    if (result.resource.status === "draft") {
      showDrafts(result.resource.id);
      setImportStatus(`${result.resource.questionCount} questions generated. Review them below before using them.`, false);
    } else setImportStatus(result.resource.questionCount ? `${result.resource.questionCount} questions added.` : "Resource saved. No matching definitions were found within this outline; add clearer text notes or a prepared question bank.", false);
  }

  function showDrafts(resourceId) {
    draftResourceId = resourceId;
    const panel = document.getElementById("draft-preview"), list = document.getElementById("draft-list");
    panel.hidden = false; list.replaceChildren();
    (library.drafts || []).filter(q => q.resourceId === resourceId).forEach(q => {
      const label = document.createElement("label"); label.className = "draft-row";
      const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.value = q.id; checkbox.checked = true;
      const text = document.createElement("span"), prompt = document.createElement("strong"), answer = document.createElement("small"), source = document.createElement("small");
      prompt.textContent = `${q.type.toUpperCase()} · ${q.prompt}`;
      answer.textContent = `Answer: ${QuizCore.isChoiceQuestion(q) ? q.choices[q.correctIndex] : q.type === "fill" ? q.acceptedAnswers[0] : q.sampleAnswer}`;
      source.textContent = `Source: ${q.source} — ${q.sourceExcerpt}`;
      text.append(prompt, answer, source); label.append(checkbox, text); list.append(label);
    });
  }

  async function handleResourceFiles(files) {
    const inputs = [document.getElementById("resource-file"), elements.questionFile];
    inputs.forEach(input => input.disabled = true);
    const outcomes = [];
    try {
      for (const file of files) {
        try { await uploadResource(file); outcomes.push(`${file.name}: saved`); }
        catch (error) { outcomes.push(`${file.name}: ${error.message}`); }
      }
      setImportStatus(outcomes.join(" · "), outcomes.some(message => !message.endsWith(": saved")));
    } finally { inputs.forEach(input => { input.disabled = false; input.value = ""; }); }
  }

  function skipAnswer() {
    if (answerLocked) return;
    skippedAnswers++;
    attempts.push({ question: quizQuestions[questionIndex], answer: "", correct: false, skipped: true });
    questionIndex++;
    if (questionIndex === quizQuestions.length) finishQuiz(); else renderQuestion();
  }

  initializeStorage();
  document.getElementById("topic-filter").addEventListener("change", renderTopicPreview);
  elements.start.addEventListener("click", startQuiz);
  elements.replay.addEventListener("click", startQuiz);
  elements.submit.addEventListener("click", submitAnswer);
  elements.exit.addEventListener("click", () => setVisibleView("welcome"));
  elements.openImport.addEventListener("click", openImportDialog);
  elements.questionFile.addEventListener("change", (event) => importQuestionFile(event.target.files[0]));
  document.getElementById("resource-file").addEventListener("change", event => handleResourceFiles([...event.target.files]));
  document.getElementById("skip-answer").addEventListener("click", skipAnswer);
  document.getElementById("results-home").addEventListener("click", () => setVisibleView("welcome"));
  document.getElementById("edit-outline").addEventListener("click", () => {
    document.getElementById("outline-source").textContent = `Course: ${library.course || "LAT 313"}. Based on: ${library.outlineSource || "the existing course question bank"}.`;
    document.getElementById("outline-text").value = library.topics.map(t => `${t.name} | ${t.keywords.join(", ")}`).join("\n");
    document.getElementById("outline-dialog").showModal();
  });
  document.getElementById("save-outline").addEventListener("click", async () => {
    const status = document.getElementById("outline-status");
    try {
      if (!serverAvailable) throw new Error("Start the local server to save the outline.");
      const topics = document.getElementById("outline-text").value.split("\n").filter(line => line.trim()).map(line => {
        const [name, terms] = line.split("|");
        if (!name?.trim() || !terms?.trim()) throw new Error("Use: topic name | keyword, keyword");
        return { name: name.trim(), keywords: terms.split(",").map(k => k.trim()).filter(Boolean) };
      });
      library = await api("/api/outline", { topics }); renderLibrary(); status.textContent = "Outline saved. Future uploads and practice sets use these topics.";
    } catch (error) { status.textContent = error.message; }
  });
  document.getElementById("publish-drafts").addEventListener("click", async () => {
    const button = document.getElementById("publish-drafts"); button.disabled = true;
    try {
      const ids = [...document.querySelectorAll('#draft-list input:checked')].map(input => input.value);
      library = await api("/api/publish", { resourceId: draftResourceId, ids });
      document.getElementById("draft-preview").hidden = true;
      renderLibrary(); setImportStatus(`${ids.length} reviewed questions added to practice.`, false);
    } catch (error) { setImportStatus(error.message, true); }
    finally { button.disabled = false; }
  });
  elements.answer.addEventListener("keydown", event => {
    if (event.key === "Enter" && event.target.tagName === "INPUT" && event.target.type === "text") { event.preventDefault(); submitAnswer(); }
  });
  loadLibrary();
})();
