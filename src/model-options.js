// Config option ids differ per model, and a model rejects any id it does not declare. The set is
// knowable only once a model is selected, from the configOptions the agent echoes back.

// Mirrors cursor-agent's own classifier.
const THOUGHT_LEVEL_IDS = new Set(["thinking", "reasoning", "effort", "thought_level"]);

export function isThoughtLevel(opt) {
  const id = typeof opt?.id === "string" ? opt.id.toLowerCase() : "";
  if (THOUGHT_LEVEL_IDS.has(id)) return true;
  const name = typeof opt?.name === "string" ? opt.name.toLowerCase() : "";
  return /thinking|reasoning|thought/.test(name);
}

export function optionsFrom(res) {
  return Array.isArray(res?.configOptions) ? res.configOptions : undefined;
}

export function allowedValues(opt) {
  return (Array.isArray(opt?.options) ? opt.options : [])
    .map((o) => o?.value)
    .filter((v) => typeof v === "string");
}

// Resolve only values the selected model advertised. This keeps future vocabularies working
// without aliases or a ranking table: xhigh, extra-high, max and ultra are just exact tokens.
// A reported config list with no thought-level option is authoritative (unsupported); no list,
// an empty list, or a thought-level option with no usable id/values is not.
export function resolveEffort(options, value) {
  if (!Array.isArray(options) || options.length === 0) return { status: "unavailable" };

  const candidates = options.filter(isThoughtLevel);
  if (candidates.length === 0) return { status: "unsupported", accepted: [] };

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
