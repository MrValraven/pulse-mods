// pulse-progress /pulse arguments: pure functions, so the tests read them without an engine.

export const PULSE_ARGUMENTS = [
  { name: 'open', description: 'Open the Pulse panel' },
  { name: 'close', description: 'Close the Pulse panel' },
  { name: 'help', description: 'List the /pulse commands, settings and the price date' },
  { name: 'mods', description: 'Compare the installed pulse mods with GitHub and show the update steps' },
] as const

export type PulseArgument = (typeof PULSE_ARGUMENTS)[number]['name']

export type ParsedPulseArgs = { kind: 'toggle' } | { kind: PulseArgument } | { kind: 'unknown'; argument: string }

/** What `/pulse <args>` asks for: bare toggles the panel; anything else is one of PULSE_ARGUMENTS or unknown. */
export function parsePulseArgs(args: string | undefined): ParsedPulseArgs {
  const argument = (args ?? '').trim()
  if (!argument) return { kind: 'toggle' }
  const known = PULSE_ARGUMENTS.find(item => item.name === argument.toLowerCase())
  return known ? { kind: known.name } : { kind: 'unknown', argument }
}

export const unknownArgumentText = (argument: string): string =>
  `/pulse does not take "${argument}". It takes open, close, help or mods.`

/** The /pulse help reply: commands, settings with their current values, and the price date. Plain text lines. */
export function helpText(settings: { autoOpen: string; updateCheck: string }, pricesAsOf: string): string {
  return [
    'Pulse commands:',
    '/pulse          open or close the Pulse panel of subagents',
    '/pulse open     open the panel',
    '/pulse close    close the panel',
    '/pulse help     show this list',
    '/pulse mods     compare the installed pulse mods with GitHub and show the update steps',
    '',
    'The band: "Agents N" opens the panel. "Clear finished" clears the finished runs, and "Undo clear" brings them back for 10 seconds. With no finished runs the same button reads "Hide band" and hides the band.',
    '',
    'Settings (/config, pulse-progress):',
    `Open the agents panel (autoOpen): once or never, now ${settings.autoOpen}`,
    `Check for pulse mods updates (updateCheck): on or off, a quiet check at session start once a day, now ${settings.updateCheck}`,
    '',
    `Costs are estimates from list prices as of ${pricesAsOf}.`,
  ].join('\n')
}

/** Typeahead rows for the argument after "/pulse ", or none when the token is elsewhere in the prompt. */
export function pulseSuggestions(text: string, start: number, token: string): { text: string; description: string }[] {
  if (!/^\s*\/pulse\s+$/.test(text.slice(0, start))) return []
  const typed = token.toLowerCase()
  return PULSE_ARGUMENTS.filter(item => item.name.startsWith(typed)).map(item => ({ text: item.name, description: item.description }))
}
