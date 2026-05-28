import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { askMultiSelectQuestion, askQuestionnaire } from "../../src/shared/interactive-questions.ts";

const optionSchema = Type.Object({
    label: Type.String({ description: "Short option label shown to the user" }),
    value: Type.Optional(Type.String({ description: "Value returned to the agent; defaults to label" })),
    description: Type.Optional(Type.String({ description: "Optional explanatory text shown under the option" })),
    selected: Type.Optional(Type.Boolean({ description: "For multi-select questions, whether this option starts selected" })),
});

const questionSchema = Type.Object({
    id: Type.String({ description: "Stable id for this question" }),
    label: Type.Optional(Type.String({ description: "Short tab label; defaults to id" })),
    question: Type.String({ description: "The question to ask the user" }),
    options: Type.Array(optionSchema, { description: "Available answers for the user to choose from" }),
    allowMultiple: Type.Optional(Type.Boolean({ description: "Allow selecting multiple answers for this question. Defaults to true. Set false for single-select." })),
    allowOther: Type.Optional(Type.Boolean({ description: "Allow typing a custom answer if the listed options are not adequate. Defaults to false." })),
    otherLabel: Type.Optional(Type.String({ description: "Label for the custom-answer option. Defaults to 'Other / type your own answer'." })),
});


const askUserSchema = Type.Object({
    question: Type.Optional(Type.String({ description: "The question to ask the user. Use for one question." })),
    options: Type.Optional(Type.Array(optionSchema, { description: "Available answers for one question" })),
    allowMultiple: Type.Optional(Type.Boolean({ description: "Allow selecting multiple answers for one question. Defaults to true. Set false for single-select." })),
    allowOther: Type.Optional(Type.Boolean({ description: "Allow typing a custom answer for one question. Defaults to false." })),
    otherLabel: Type.Optional(Type.String({ description: "Label for the custom-answer option for one question." })),
    questions: Type.Optional(Type.Array(questionSchema, { description: "Ask several questions in one tabbed interaction. Prefer this over multiple ask_user calls when you need more than one answer." })),
});

type AskUserOption = {
    label: string;
    value?: string;
    description?: string;
    selected?: boolean;
};

type AskUserQuestion = {
    id: string;
    label?: string;
    question: string;
    options: AskUserOption[];
    allowMultiple?: boolean;
    allowOther?: boolean;
    otherLabel?: string;
};

type AskUserDetails = {
    question?: string;
    allowMultiple?: boolean;
    options?: AskUserOption[];
    selected?: string[];
    questions?: AskUserQuestion[];
    answers?: Array<{ id: string; selected: string[] }>;
    cancelled: boolean;
};

export default function (pi: ExtensionAPI) {
    pi.registerTool({
        name: "ask_user",
        label: "Ask User",
        description: "Ask the user one or more interactive multiple-choice questions and return their selected answer(s). Use when you need clarification, preferences, or confirmation before proceeding.",
        promptSnippet: "Ask the user one or more interactive multiple-choice questions and return selected answer(s)",
        promptGuidelines: [
            "Use ask_user when required information is ambiguous and the user can choose from a concise set of options.",
            "When asking more than one related question, use ask_user questions[] so the user can answer them in one tabbed interaction instead of making several ask_user calls.",
            "Do not use ask_user for purely open-ended questions; use allowOther only as a fallback when predefined options may not be adequate.",
            "When using ask_user, provide clear option labels, set allowMultiple false only when exactly one answer is valid, and set allowOther when the listed options may not be adequate.",
        ],
        parameters: askUserSchema,

        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const rawQuestions = Array.isArray(params.questions) ? params.questions as AskUserQuestion[] : [];

            if (!ctx.hasUI) {
                return {
                    content: [{ type: "text", text: "Unable to ask the user: interactive UI is not available." }],
                    details: { cancelled: true } satisfies AskUserDetails,
                };
            }

            if (rawQuestions.length > 0) {
                const questions = rawQuestions.map((question, index) => ({
                    ...question,
                    label: question.label ?? `Q${index + 1}`,
                    options: question.options.map((option) => ({
                        ...option,
                        value: option.value ?? option.label,
                    })),
                }));

                if (questions.some((question) => question.options.length === 0 && !question.allowOther)) {
                    return {
                        content: [{ type: "text", text: "Unable to ask the user: every question needs at least one option unless allowOther is true." }],
                        details: { questions, answers: [], cancelled: true } satisfies AskUserDetails,
                    };
                }

                const answers = await askQuestionnaire<string>(ctx, {
                    title: params.question ?? "Questions",
                    questions: questions.map((question) => ({
                        id: question.id,
                        label: question.label,
                        question: question.question,
                        multiple: question.allowMultiple !== false,
                        allowOther: question.allowOther === true,
                        otherLabel: question.otherLabel,
                        options: question.options.map((option) => ({
                            label: option.label,
                            value: option.value,
                            selected: option.selected ?? false,
                        })),
                    })),
                });

                const details: AskUserDetails = {
                    questions,
                    answers,
                    cancelled: answers.length === 0,
                };

                if (answers.length === 0) {
                    return {
                        content: [{ type: "text", text: "The user cancelled the questions." }],
                        details,
                    };
                }

                const answerText = answers
                    .map((answer) => `${answer.id}: ${answer.selected.join(", ")}`)
                    .join("\n");
                return {
                    content: [{ type: "text", text: answerText }],
                    details,
                };
            }

            const allowMultiple = params.allowMultiple !== false;
            const allowOther = params.allowOther === true;
            const normalizedOptions = ((params.options ?? []) as AskUserOption[]).map((option) => ({
                ...option,
                value: option.value ?? option.label,
            }));

            if (!params.question || (normalizedOptions.length === 0 && !allowOther)) {
                return {
                    content: [{ type: "text", text: "Unable to ask the user: provide either questions[] or question with options[]." }],
                    details: { cancelled: true } satisfies AskUserDetails,
                };
            }

            if (allowOther) {
                const answers = await askQuestionnaire<string>(ctx, {
                    title: params.question,
                    questions: [{
                        id: "answer",
                        label: "Answer",
                        question: params.question,
                        multiple: allowMultiple,
                        allowOther: true,
                        otherLabel: params.otherLabel,
                        options: normalizedOptions.map((option) => ({
                            label: option.label,
                            value: option.value,
                            selected: option.selected ?? false,
                        })),
                    }],
                });
                const selected = answers[0]?.selected.map(String) ?? [];
                const details: AskUserDetails = {
                    question: params.question,
                    allowMultiple,
                    options: normalizedOptions,
                    selected,
                    cancelled: selected.length === 0,
                };
                return {
                    content: [{ type: "text", text: selected.length === 0 ? "The user cancelled or selected no options." : `User selected: ${selected.join(", ")}` }],
                    details,
                };
            }

            const selected = await askMultiSelectQuestion<string>(ctx, {
                title: params.question,
                multiple: allowMultiple,
                options: normalizedOptions.map((option) => ({
                    label: option.label,
                    value: option.value,
                    selected: option.selected ?? false,
                    renderDetails: (_candidate, { theme, selected, wrap }) => {
                        const lines = [theme.fg("accent", theme.bold(option.label))];
                        if (allowMultiple) {
                            lines.push(`Selected: ${selected ? theme.fg("success", "yes") : theme.fg("muted", "no")}`);
                        }
                        if (option.description) {
                            lines.push("");
                            lines.push(...wrap(option.description));
                        }
                        return lines;
                    },
                })),
            });

            const details: AskUserDetails = {
                question: params.question,
                allowMultiple,
                options: normalizedOptions,
                selected,
                cancelled: selected.length === 0,
            };

            if (selected.length === 0) {
                return {
                    content: [{ type: "text", text: "The user cancelled or selected no options." }],
                    details,
                };
            }

            return {
                content: [{ type: "text", text: `User selected: ${selected.join(", ")}` }],
                details,
            };
        },

        renderCall(args, theme) {
            const questionCount = Array.isArray(args.questions) ? args.questions.length : 0;
            if (questionCount > 0) {
                return new Text(
                    theme.fg("toolTitle", theme.bold("ask_user ")) +
                    theme.fg("muted", `${questionCount} questions`) +
                    theme.fg("dim", " (tabbed)"),
                    0,
                    0,
                );
            }

            const optionCount = Array.isArray(args.options) ? args.options.length : 0;
            const mode = args.allowMultiple === false ? "single-select" : "multi-select";
            return new Text(
                theme.fg("toolTitle", theme.bold("ask_user ")) +
                theme.fg("muted", String(args.question ?? "")) +
                theme.fg("dim", ` (${optionCount} options, ${mode})`),
                0,
                0,
            );
        },

        renderResult(result, _options, theme) {
            const details = result.details as AskUserDetails | undefined;
            if (!details) {
                const text = result.content[0];
                return new Text(text?.type === "text" ? text.text : "", 0, 0);
            }

            if (details.cancelled) {
                return new Text(theme.fg("warning", "No answer selected"), 0, 0);
            }

            if (details.answers) {
                const lines = details.answers.map((answer) => (
                    `${theme.fg("success", "✓ ")}${theme.fg("accent", answer.id)}: ${answer.selected.join(", ")}`
                ));
                return new Text(lines.join("\n"), 0, 0);
            }

            return new Text(theme.fg("success", "✓ ") + theme.fg("accent", (details.selected ?? []).join(", ")), 0, 0);
        },
    });
}
