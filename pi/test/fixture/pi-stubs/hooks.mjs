// Module hooks for the wiring test: stand-ins for the Pi packages the
// extension imports at run time, so it loads without Pi installed.
const stubs = {
  // Box and Text keep what they are given, so a test can read a rendered card.
  '@earendil-works/pi-tui':
    'export class Box { constructor(...args) { this.args = args; this.children = [] } addChild(child) { this.children.push(child) } }\n' +
    'export class Text { constructor(text) { this.text = text } }\n',
  typebox: 'export const Type = { Object: () => ({}), Optional: (t) => t, Array: () => ({}), String: () => ({}) }\n',
}

export async function resolve(specifier, context, next) {
  if (specifier in stubs) {
    return { url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`, shortCircuit: true }
  }
  return next(specifier, context)
}
