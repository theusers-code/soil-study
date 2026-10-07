(function () {
  "use strict";
  const ids = ["ph-neutral", "kaolinite-layer", "expanding-clays"];
  const questions = ids.map(id => window.SOIL_QUESTION_BANK.find(q => q.id === id)).filter(Boolean);
  const prompt = document.getElementById("warmup-prompt");
  const options = document.getElementById("warmup-options");
  const feedback = document.getElementById("warmup-feedback");
  const next = document.getElementById("next-warmup");
  const mascot = document.querySelector(".sprout-art");
  let index = 0;
  function render() {
    const question = questions[index];
    if (!question) return;
    prompt.textContent = question.prompt;
    options.replaceChildren();
    feedback.textContent = "Trust your roots. Take a guess!";
    next.hidden = true;
    QuizCore.shuffle(question.choices.map((text, choice) => ({ text, choice }))).forEach(option => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "warmup-choice";
      button.textContent = option.text;
      button.dataset.choice = String(option.choice);
      button.addEventListener("click", () => {
        const correct = option.choice === question.correctIndex;
        for (const choice of options.querySelectorAll("button")) {
          choice.disabled = true;
          if (Number(choice.dataset.choice) === question.correctIndex) choice.classList.add("is-correct");
        }
        if (!correct) button.classList.add("is-incorrect");
        feedback.textContent = correct ? `Nice one! ${question.explanation}` : `A little learning moment: ${question.choices[question.correctIndex]}. ${question.explanation}`;
        if (correct) {
          mascot.classList.add("is-cheering");
          window.setTimeout(() => mascot.classList.remove("is-cheering"), 750);
        }
        next.hidden = false;
      });
      options.append(button);
    });
  }
  next.addEventListener("click", () => { index = (index + 1) % questions.length; render(); });
  render();
})();
