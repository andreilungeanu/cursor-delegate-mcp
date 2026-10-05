// Config option ids differ per model, and a model rejects any id it does not declare. The set is
// knowable only once a model is selected, from the configOptions the agent echoes back.

// ACP marks a thought/reasoning level selector with category "thought_level" — grok-4.7 declares
// reasoning_effort ("Effort") that way. Categories are optional in ACP, so the ids and names
// below still classify options from an agent that sends none. A match only nominates an option:
// the requested value must still appear exactly among the values it advertises.
const THOUGHT_LEVEL_IDS = new Set(["thinking", "reasoning", "effort", "reasoning_effort", "thought_level"]);
// Never an effort setting, and doctor reports them as currentModel and modes, so a list of what a
// model offers leaves them out.
const SELECTOR_IDS = new Set(["model", "mode"]);

export function isThoughtLevel(opt) {
  if (opt?.category === "thought_level") return true;
  const id = typeof opt?.id === "string" ? opt.id.toLowerCase() : "";
  if (THOUGHT_LEVEL_IDS.has(id)) return true;
  const name = typeof opt?.name === "string" ? opt.name.toLowerCase() : "";
  return /thinking|reasoning|thought|effort/.test(name);
}

export function optionsFrom(res) {
  return Array.isArray(res?.configOptions) ? res.configOptions : undefined;
}

export function allowedValues(opt) {
  return (Array.isArray(opt?.options) ? opt.options : [])
    .map((o) => o?.value)
    .filter((v) => typeof v === "string");
}

// What a model offers besides the model and mode selectors, as doctor reports it and as an
// unrecognized effort names it. Optional metadata appears only when the agent sent a string.
export function describeOptions(options) {
  return (Array.isArray(options) ? options : [])
    .filter((o) => typeof o?.id === "string" && !SELECTOR_IDS.has(o.id))
    .map((o) => ({
      id: o.id,
      ...(typeof o.name === "string" ? { name: o.name } : {}),
      ...(typeof o.category === "string" ? { category: o.category } : {}),
      values: allowedValues(o),
      ...(typeof o.currentValue === "string" ? { currentValue: o.currentValue } : {}),
    }));
}

// The current value of every recognized effort option, keyed by id. All of them rather than one
// picked: a model can declare a thinking toggle beside a level, and either alone can mislead.
// Undefined when no recognized option reports a string value.
export function effortSettings(options) {
  const settings = {};
  for (const o of Array.isArray(options) ? options : []) {
    if (isThoughtLevel(o) && typeof o?.id === "string" && typeof o.currentValue === "string") {
      settings[o.id] = o.currentValue;
    }
  }
  return Object.keys(settings).length > 0 ? settings : undefined;
}

// Resolve only values the selected model advertised. This keeps future vocabularies working
// without aliases or a ranking table: xhigh, extra-high, max and ultra are just exact tokens.
// No list, an empty list, or a thought-level option with no usable id/values is unavailable. A
// list with nothing classified as thought-level is unrecognized — not proof the model has no
// effort setting: categories are optional and ids get renamed, so the caller is shown the list.
export function resolveEffort(options, value) {
  if (!Array.isArray(options) || options.length === 0) return { status: "unavailable" };

  const candidates = options.filter(isThoughtLevel);
  if (candidates.length === 0) return { status: "unrecognized", advertised: describeOptions(options) };

  const usable = candidates.filter((o) => typeof o?.id === "string");
  const accepted = [...new Set(usable.flatMap(allowedValues))];
  if (usable.length === 0 || accepted.length === 0) return { status: "unavailable" };

  const pick = usable.find((o) => allowedValues(o).includes(value));
  if (pick === undefined) return { status: "invalid", accepted };
  return { status: "matched", id: pick.id, value };
}

// Effort failures are fatal before the prompt. Only fast and context reach this soft-diagnostic
// path, and both are sent under their own names.
export function unsupportedWarning(model, { arg }) {
  return `model ${model} has no ${arg} option; the requested value was ignored`;
}
