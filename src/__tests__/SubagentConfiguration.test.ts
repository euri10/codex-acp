import {expect, it} from "vitest";
import {subagentConfigurationOptions} from "../subagents/SubagentConfiguration";

// Native 0.159.1 replay omission: dotfiles-j684, /tmp/louiselm-42za-subagent-stack.log.
// These conversion checks cover field presence, not event ordering.
it("omits effort absent from native subagent history instead of inventing a value", () => {
    const observed = JSON.parse('{"model":"child-model"}');
    const options = subagentConfigurationOptions({currentModel: null, availableModels: []}, observed);
    expect(options).toHaveLength(1);
    expect(options[0]).toMatchObject({category: "model", currentValue: "child-model"});
});

it("omits configuration when native subagent history reports neither field", () => {
    expect(subagentConfigurationOptions({currentModel: null, availableModels: []}, JSON.parse('{}'))).toEqual([]);
});
