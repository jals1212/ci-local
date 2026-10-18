// Module hooks for the wiring test: stand-ins for the Pi packages the
// extension imports at run time, so it loads without Pi installed.
const stubs = {
  '@earendil-works/pi-tui': 'export class Box { addChild() {} }\nexport class Text {}\n',
  typebox: 'export const Type = { Object: () => ({}) }\n',
}

export async function resolve(specifier, context, next) {
  if (specifier in stubs) {
    return { url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`, shortCircuit: true }
  }
  return next(specifier, context)
}
