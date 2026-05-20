import { Editor, type EditorTheme, Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export type InteractiveNotifyContext = {
    hasUI: boolean;
    ui: {
        custom<T>(factory: (...args: any[]) => any, options?: any): Promise<T>;
    };
};

export type InteractiveQuestionOption<T> = {
    label: string;
    value: T;
    selected?: boolean;
    renderDetails?: (option: InteractiveQuestionOption<T>, helpers: InteractiveQuestionRenderHelpers) => string[];
};

export type InteractiveQuestionRenderHelpers = {
    theme: any;
    width: number;
    selected: boolean;
    wrap(value: string): string[];
};

export type MultiSelectQuestion<T> = {
    title: string;
    instructions?: string;
    options: Array<InteractiveQuestionOption<T>>;
    emptyMessage?: string;
    multiple?: boolean;
};

export type InteractiveQuestionnaireItem<T> = {
    id: string;
    label?: string;
    question: string;
    options: Array<InteractiveQuestionOption<T>>;
    multiple?: boolean;
    allowOther?: boolean;
    otherLabel?: string;
};

export type InteractiveQuestionnaire<T> = {
    title: string;
    instructions?: string;
    questions: Array<InteractiveQuestionnaireItem<T>>;
};

export type InteractiveQuestionnaireAnswer<T> = {
    id: string;
    selected: Array<T | string>;
};

const multiSelectInstructions = "←/→ or tab switch • space toggle • enter apply • esc cancel";
const singleSelectInstructions = "←/→ or tab switch • enter choose • esc cancel";
const questionnaireInstructions = "←/→ or tab switch • ↑/↓ option • space toggle • enter choose/submit • esc cancel";

export async function askMultiSelectQuestion<T>(
    ctx: InteractiveNotifyContext,
    question: MultiSelectQuestion<T>,
): Promise<T[]> {
    if (!ctx.hasUI || question.options.length === 0) return [];

    const multiple = question.multiple ?? true;

    return ctx.ui.custom<T[]>((tui, theme, _keybindings, done) => {
        let selectedIndex = 0;
        const selectedIndexes = new Set<number>();

        if (multiple) {
            question.options.forEach((option, index) => {
                if (option.selected ?? true) selectedIndexes.add(index);
            });
        }

        function toggleSelected() {
            if (!multiple) return;

            if (selectedIndexes.has(selectedIndex)) {
                selectedIndexes.delete(selectedIndex);
            } else {
                selectedIndexes.add(selectedIndex);
            }
        }

        function finish() {
            if (!multiple) {
                done([question.options[selectedIndex].value]);
                return;
            }

            done(question.options
                .filter((_option, index) => selectedIndexes.has(index))
                .map((option) => option.value));
        }

        function render(width: number) {
            const safeWidth = Math.max(width, 20);
            const option = question.options[selectedIndex];
            const lines: string[] = [];
            const isSelected = multiple ? selectedIndexes.has(selectedIndex) : true;
            const helpers: InteractiveQuestionRenderHelpers = {
                theme,
                width: safeWidth,
                selected: isSelected,
                wrap: (value: string) => wrapTextWithAnsi(value, safeWidth),
            };

            lines.push(theme.fg("accent", theme.bold(question.title)));
            lines.push(theme.fg("dim", question.instructions ?? (multiple ? multiSelectInstructions : singleSelectInstructions)));
            lines.push("");

            if (!option) {
                lines.push(theme.fg("muted", question.emptyMessage ?? "No options available."));
                return lines.map((line) => truncateToWidth(line, safeWidth));
            }

            const tabs = question.options.map((candidate, index) => {
                const checked = selectedIndexes.has(index) ? "✓" : " ";
                const label = multiple ? ` ${checked} ${candidate.label} ` : ` ${candidate.label} `;
                return index === selectedIndex
                    ? theme.bg("selectedBg", theme.fg("accent", label))
                    : theme.fg("muted", label);
            }).join(" ");
            lines.push(...wrapTextWithAnsi(tabs, safeWidth));
            lines.push("");

            if (option.renderDetails) {
                lines.push(...option.renderDetails(option, helpers));
            } else {
                lines.push(theme.fg("accent", theme.bold(option.label)));
                if (multiple) {
                    const selectedText = selectedIndexes.has(selectedIndex)
                        ? theme.fg("success", "yes")
                        : theme.fg("muted", "no");
                    lines.push(`Selected: ${selectedText}`);
                }
            }

            lines.push("");
            lines.push(theme.fg("dim", `${selectedIndex + 1}/${question.options.length} options`));

            return lines.map((line) => truncateToWidth(line, safeWidth));
        }

        return {
            render,
            invalidate() {},
            handleInput(data: string) {
                if (matchesKey(data, Key.escape)) {
                    done([]);
                    return;
                }

                if (matchesKey(data, Key.enter)) {
                    finish();
                    return;
                }

                if (matchesKey(data, Key.space)) {
                    if (multiple) {
                        toggleSelected();
                        tui.requestRender();
                    }
                    return;
                }

                if (matchesKey(data, Key.left) || matchesKey(data, Key.shift("tab"))) {
                    selectedIndex = Math.max(0, selectedIndex - 1);
                    tui.requestRender();
                    return;
                }

                if (matchesKey(data, Key.right) || matchesKey(data, Key.tab)) {
                    selectedIndex = Math.min(question.options.length - 1, selectedIndex + 1);
                    tui.requestRender();
                }
            },
        };
    });
}

export async function askQuestionnaire<T>(
    ctx: InteractiveNotifyContext,
    questionnaire: InteractiveQuestionnaire<T>,
): Promise<InteractiveQuestionnaireAnswer<T>[]> {
    if (!ctx.hasUI || questionnaire.questions.length === 0) return [];

    return ctx.ui.custom<InteractiveQuestionnaireAnswer<T>[]>((tui, theme, _keybindings, done) => {
        let tabIndex = 0;
        let optionIndex = 0;
        let inputMode = false;
        let inputQuestionId: string | undefined;
        const selections = new Map<string, Set<number>>();
        const customAnswers = new Map<string, string>();

        const editorTheme: EditorTheme = {
            borderColor: (text) => theme.fg("accent", text),
            selectList: {
                selectedPrefix: (text) => theme.fg("accent", text),
                selectedText: (text) => theme.fg("accent", text),
                description: (text) => theme.fg("muted", text),
                scrollInfo: (text) => theme.fg("dim", text),
                noMatch: (text) => theme.fg("warning", text),
            },
        };
        const editor = new Editor(tui, editorTheme);

        questionnaire.questions.forEach((question) => {
            const selected = new Set<number>();
            if (question.multiple) {
                question.options.forEach((option, index) => {
                    if (option.selected) selected.add(index);
                });
            }
            selections.set(question.id, selected);
        });

        editor.onSubmit = (value) => {
            if (!inputQuestionId) return;
            const trimmed = value.trim();
            const question = questionnaire.questions.find((candidate) => candidate.id === inputQuestionId);
            if (trimmed) customAnswers.set(inputQuestionId, trimmed);
            else customAnswers.delete(inputQuestionId);
            if (question && !question.multiple && trimmed) {
                selections.get(question.id)?.clear();
                tabIndex = Math.min(questionnaire.questions.indexOf(question) + 1, questionnaire.questions.length);
                optionIndex = 0;
            }
            inputMode = false;
            inputQuestionId = undefined;
            editor.setText("");
            tui.requestRender();
        };

        function currentQuestion() {
            return questionnaire.questions[tabIndex];
        }

        function optionCount(question: InteractiveQuestionnaireItem<T>) {
            return question.options.length + (question.allowOther ? 1 : 0);
        }

        function isOtherOption(question: InteractiveQuestionnaireItem<T>, index: number) {
            return question.allowOther === true && index === question.options.length;
        }

        function currentSelections() {
            const question = currentQuestion();
            return question ? selections.get(question.id) ?? new Set<number>() : new Set<number>();
        }

        function isSubmitTab() {
            return tabIndex === questionnaire.questions.length;
        }

        function hasAnswer(question: InteractiveQuestionnaireItem<T>) {
            return (selections.get(question.id)?.size ?? 0) > 0 || customAnswers.has(question.id);
        }

        function allAnswered() {
            return questionnaire.questions.every(hasAnswer);
        }

        function moveTab(delta: number) {
            const totalTabs = questionnaire.questions.length + 1;
            tabIndex = (tabIndex + delta + totalTabs) % totalTabs;
            optionIndex = 0;
            inputMode = false;
            inputQuestionId = undefined;
            editor.setText("");
            tui.requestRender();
        }

        function openOtherEditor(question: InteractiveQuestionnaireItem<T>) {
            inputMode = true;
            inputQuestionId = question.id;
            editor.setText(customAnswers.get(question.id) ?? "");
            tui.requestRender();
        }

        function selectCurrentOption() {
            const question = currentQuestion();
            if (!question || optionCount(question) === 0) return;

            if (isOtherOption(question, optionIndex)) {
                openOtherEditor(question);
                return;
            }

            const selected = currentSelections();
            if (question.multiple) {
                if (selected.has(optionIndex)) selected.delete(optionIndex);
                else selected.add(optionIndex);
            } else {
                selected.clear();
                customAnswers.delete(question.id);
                selected.add(optionIndex);
                tabIndex = Math.min(tabIndex + 1, questionnaire.questions.length);
                optionIndex = 0;
            }
            selections.set(question.id, selected);
            tui.requestRender();
        }

        function selectedLabels(question: InteractiveQuestionnaireItem<T>) {
            const labels = Array.from(selections.get(question.id) ?? [])
                .sort((a, b) => a - b)
                .map((index) => question.options[index].label);
            const custom = customAnswers.get(question.id);
            if (custom) labels.push(custom);
            return labels;
        }

        function finish() {
            if (!allAnswered()) return;

            done(questionnaire.questions.map((question) => {
                const selected = Array.from(selections.get(question.id) ?? [])
                    .sort((a, b) => a - b)
                    .map((index) => question.options[index].value as T | string);
                const custom = customAnswers.get(question.id);
                if (custom) selected.push(custom);
                return { id: question.id, selected };
            }));
        }

        function renderTabs(width: number) {
            const tabs = questionnaire.questions.map((question, index) => {
                const answered = hasAnswer(question) ? "✓" : " ";
                const label = ` ${answered} ${question.label ?? question.id} `;
                return index === tabIndex
                    ? theme.bg("selectedBg", theme.fg("accent", label))
                    : theme.fg(hasAnswer(question) ? "success" : "muted", label);
            });
            const submitLabel = ` ${allAnswered() ? "✓" : " "} Submit `;
            tabs.push(isSubmitTab()
                ? theme.bg("selectedBg", theme.fg("accent", submitLabel))
                : theme.fg(allAnswered() ? "success" : "dim", submitLabel));
            return wrapTextWithAnsi(tabs.join(" "), width);
        }

        function render(width: number) {
            const safeWidth = Math.max(width, 20);
            const lines: string[] = [];

            lines.push(theme.fg("accent", theme.bold(questionnaire.title)));
            lines.push(theme.fg("dim", questionnaire.instructions ?? questionnaireInstructions));
            lines.push("");
            lines.push(...renderTabs(safeWidth));
            lines.push("");

            if (isSubmitTab()) {
                lines.push(theme.fg("accent", theme.bold("Review answers")));
                lines.push("");
                for (const question of questionnaire.questions) {
                    const selected = selectedLabels(question);
                    const answerText = selected.length > 0 ? selected.join(", ") : theme.fg("warning", "unanswered");
                    lines.push(`${theme.fg("muted", `${question.label ?? question.id}:`)} ${answerText}`);
                }
                lines.push("");
                lines.push(allAnswered()
                    ? theme.fg("success", "Press Enter to submit")
                    : theme.fg("warning", "Answer all questions before submitting"));
                return lines.map((line) => truncateToWidth(line, safeWidth));
            }

            const question = currentQuestion();
            const selected = currentSelections();
            lines.push(theme.fg("accent", theme.bold(question.question)));
            lines.push("");

            question.options.forEach((option, index) => {
                const active = index === optionIndex && !inputMode;
                const checked = selected.has(index) ? "✓" : " ";
                const prefix = active ? theme.fg("accent", "> ") : "  ";
                const label = question.multiple ? `[${checked}] ${option.label}` : `${checked === "✓" ? "●" : "○"} ${option.label}`;
                lines.push(prefix + (active ? theme.fg("accent", label) : theme.fg("text", label)));
                if (option.description) {
                    lines.push(...wrapTextWithAnsi(`    ${option.description}`, safeWidth));
                }
            });

            if (question.allowOther) {
                const active = optionIndex === question.options.length && !inputMode;
                const custom = customAnswers.get(question.id);
                const checked = custom ? "✓" : " ";
                const prefix = active ? theme.fg("accent", "> ") : "  ";
                const label = question.multiple
                    ? `[${checked}] ${question.otherLabel ?? "Other / type your own answer"}`
                    : `${custom ? "●" : "○"} ${question.otherLabel ?? "Other / type your own answer"}`;
                lines.push(prefix + (active ? theme.fg("accent", label) : theme.fg("text", label)));
                if (custom) lines.push(`    ${theme.fg("muted", custom)}`);
            }

            if (inputMode && inputQuestionId === question.id) {
                lines.push("");
                lines.push(theme.fg("muted", "Your answer:"));
                for (const line of editor.render(safeWidth - 2)) {
                    lines.push(` ${line}`);
                }
                lines.push(theme.fg("dim", "Enter to save • Esc to cancel typing"));
            }

            lines.push("");
            lines.push(theme.fg("dim", `${tabIndex + 1}/${questionnaire.questions.length} questions`));

            return lines.map((line) => truncateToWidth(line, safeWidth));
        }

        return {
            render,
            invalidate() {},
            handleInput(data: string) {
                if (inputMode) {
                    if (matchesKey(data, Key.escape)) {
                        inputMode = false;
                        inputQuestionId = undefined;
                        editor.setText("");
                        tui.requestRender();
                        return;
                    }
                    editor.handleInput(data);
                    tui.requestRender();
                    return;
                }

                if (matchesKey(data, Key.escape)) {
                    done([]);
                    return;
                }

                if (matchesKey(data, Key.left) || matchesKey(data, Key.shift("tab"))) {
                    moveTab(-1);
                    return;
                }

                if (matchesKey(data, Key.right) || matchesKey(data, Key.tab)) {
                    moveTab(1);
                    return;
                }

                if (!isSubmitTab() && matchesKey(data, Key.up)) {
                    optionIndex = Math.max(0, optionIndex - 1);
                    tui.requestRender();
                    return;
                }

                if (!isSubmitTab() && matchesKey(data, Key.down)) {
                    optionIndex = Math.min(optionCount(currentQuestion()) - 1, optionIndex + 1);
                    tui.requestRender();
                    return;
                }

                if (!isSubmitTab() && matchesKey(data, Key.space)) {
                    selectCurrentOption();
                    return;
                }

                if (matchesKey(data, Key.enter)) {
                    if (isSubmitTab()) finish();
                    else selectCurrentOption();
                }
            },
        };
    });
}
