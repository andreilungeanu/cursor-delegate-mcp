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

function isBoolean(opt) {
  const v = allowedValues(opt).slice().sort();
  return v.length === 2 && v[0] === "false" && v[1] === "true";
}

// Claude declares thinking (true|false) and effort (low|medium|high) together, so the value picks
// the id. With no match, a non-boolean candidate still goes: the agent's own "Invalid value for X"
// names the allowed set. A boolean-only model (claude-haiku-4-5 declares just thinking) gets
// nothing — sending a level there is a guaranteed invalid value, which would fail the run.
export function resolveEffortId(options, value) {
  const candidates = (Array.isArray(options) ? options : []).filter(isThoughtLevel);
  if (candidates.length === 0) return undefined;
  const pick = candidates.find((o) => allowedValues(o).includes(value))
    ?? candidates.find((o) => !isBoolean(o));
  return typeof pick?.id === "string" ? pick.id : undefined;
}

// effort's id varies per model, so name the ids the model declares. fast and context are sent
// under their own names.
export function unsupportedWarning(model, { arg, modelOptions }) {
  if (arg !== "effort") return `model ${model} has no ${arg} option; the requested value was ignored`;
  // No reply carried a list, so claiming the model declares nothing would assert a capability
  // never observed.
  if (modelOptions === undefined) return `effort ignored: ${model} did not report its option list`;
  const ids = modelOptions.filter(isThoughtLevel).map((o) => o?.id).filter(Boolean);
  return ids.length
    ? `effort ignored: ${model} declares ${ids.join(", ")}, which did not take the requested value`
    : `effort ignored: ${model} declares no thinking or reasoning option`;
}
