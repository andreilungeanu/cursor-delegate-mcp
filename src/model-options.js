// Config option ids differ per model, and a model rejects any id it does not declare. The set is
// knowable only once a model is selected, from the configOptions the agent echoes back.

// ACP marks a reasoning-level selector with category "thought_level" (grok-4.7's reasoning_effort).
// Categories are optional, so ids and names classify too. A match only nominates an option; the
// requested value must still be one it advertises.
const THOUGHT_LEVEL_IDS = new Set(["thinking", "reasoning", "effort", "reasoning_effort", "thought_level"]);
// Never effort, and doctor reports them as currentModel and modes, so option lists leave them out.
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

// Every recognized effort option's current value, by id: a model can pair a thinking toggle with a
// level, and either alone misleads. Undefined when none reports a string value.
export function effortSettings(options) {
  const settings = {};
  for (const o of Array.isArray(options) ? options : []) {
    if (isThoughtLevel(o) && typeof o?.id === "string" && typeof o.currentValue === "string") {
      settings[o.id] = o.currentValue;
    }
  }
  return Object.keys(settings).length > 0 ? settings : undefined;
}

// Only values the model advertised, as exact tokens, with no aliases or ranking table. No list, or
// no usable id or values, is unavailable. Nothing classified as effort is unrecognized, not proof
// there is none (categories are optional, ids get renamed), so the caller is shown the list.
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
