// Variable placeholders (M1-11) — pure text logic, no DOM and no
// chrome APIs, so it can be imported and tested directly.
//
// Syntax: a token inside <angle brackets>, optionally preceded by a
// literal prefix with no space, e.g. "w<current-week>" or
// "<session-date>". The template always keeps the raw <placeholder>
// form; substitution only happens on the text actually sent or copied.
//
// A name must look like an identifier: it starts with a letter or
// underscore and continues with letters, digits, hyphens or
// underscores. That deliberately excludes things that merely happen to
// sit inside angle brackets — </closing> tags, <you@example.com>,
// <https://example.com>, Map<string,int> — none of which are variables
// and none of which Dan should be asked to fill in.
//
// Tags like <li> or Array<string> still match the identifier shape and
// can't be told apart from a real variable by pattern alone, so two
// things keep them harmless:
//   1. \<li\> escapes the brackets and is never treated as a variable.
//   2. Leaving a field blank leaves the token exactly as it is rather
//      than deleting it, so an unwanted match passes through untouched.

export const VARIABLE_PATTERN = /(?<!\\)<([A-Za-z_][A-Za-z0-9_-]*)>/g;

export function extractVariableNames(text) {
  const matches = [...text.matchAll(VARIABLE_PATTERN)];
  return [...new Set(matches.map((m) => m[1]))];
}

// Replaces \< and \> with bare angle brackets. Runs once, after
// substitution, so an escaped token reaches the target as literal text.
export function unescapeAngleBrackets(text) {
  return text.replace(/\\([<>])/g, '$1');
}

export function applyVariableValues(text, names, values) {
  let result = text;
  names.forEach((name) => {
    const value = values[name];
    // Blank (or missing) means "leave this one alone" — see the note
    // above about tokens that were never variables to begin with.
    if (value === undefined || value === '') return;
    // The replacement is a function, not a string, so a value containing
    // $&, $1 or $` is inserted literally instead of being interpreted as
    // a replacement pattern.
    result = result.replace(new RegExp(`(?<!\\\\)<${name}>`, 'g'), () => value);
  });
  return unescapeAngleBrackets(result);
}
