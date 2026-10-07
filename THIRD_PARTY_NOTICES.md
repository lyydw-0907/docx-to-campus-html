# Third party components

Project source is MIT-licensed. Dependencies retain their own licenses; this file does not replace their license texts.

| Component | Version | License / primary source |
| --- | --- | --- |
| Pandoc (native) | 3.6.4 | GPL-2.0-or-later; separately downloaded, not committed. [Source license](https://github.com/jgm/pandoc/blob/3.6.4/COPYING.md) |
| Pandoc (browser WASM) | 3.9 via pandoc-wasm 1.1.0 | GPL-2.0-or-later engine; included in the generated static distribution, not committed. [Engine source](https://github.com/jgm/pandoc/tree/3.9), [wrapper and license](https://github.com/pandoc/pandoc-wasm/tree/v1.1.0) |
| @bjorn3/browser_wasi_shim | 0.4.2 | MIT OR Apache-2.0. License texts copied from the installed package into the static distribution. |
| buffer | 6.0.3 | MIT. Browser Buffer implementation; package source and license are identified in the distribution. |
| fflate | 0.8.3 | MIT. Bounded browser ZIP preflight; package source and license are identified in the distribution. |
| esbuild | 0.28.2 (development only) | MIT. Build tool, not shipped as a runtime binary. |
| MathJax mathjax-full | 3.2.2 | Apache-2.0. [Repository](https://github.com/mathjax/MathJax-src/tree/3.2.2) |
| sharp | 0.34.5 | Apache-2.0; bundled libvips and native components retain their own licenses. [Repository](https://github.com/lovell/sharp) |
| JSZip | 3.10.1 | MIT OR GPL-3.0-or-later; project uses MIT option. [License](https://github.com/Stuk/jszip/blob/v3.10.1/LICENSE.markdown) |
| cheerio | 1.0.0 | MIT. [Repository](https://github.com/cheeriojs/cheerio/tree/v1.0.0) |
| @xmldom/xmldom | 0.9.12 override | MIT; maintained patch pinned for MathJax speech-rule-engine dependency. [Repository](https://github.com/xmldom/xmldom) |

The native application calls Pandoc as an external executable; its setup script downloads the official release separately. The browser application bundles the official unmodified WASM engine and its wrapper. The wrapper's license distinguishes MIT JavaScript glue from the GPL-2.0-or-later engine; the npm package is marked GPL-2.0-or-later. The project's MIT license does not replace the engine's license.

The generated browser distribution includes the full license texts of every bundled npm dependency (including parser and ZIP transitive dependencies), an exact version/source list in `licenses/components.json`, editable application sources in `browser-source.zip`, and upstream source/build links for Pandoc 3.9 and pandoc-wasm 1.1.0. Build artifacts remain under ignored `output/` in this local implementation.
