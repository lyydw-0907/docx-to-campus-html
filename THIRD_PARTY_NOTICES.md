# Third party components

Project source is MIT-licensed. Dependencies retain their own licenses; this file does not replace their license texts.

| Component | Version | License / primary source |
| --- | --- | --- |
| Pandoc | 3.6.4 | GPL-2.0-or-later; separately downloaded, not committed. [Source license](https://github.com/jgm/pandoc/blob/3.6.4/COPYING.md) |
| MathJax mathjax-full | 3.2.2 | Apache-2.0. [Repository](https://github.com/mathjax/MathJax-src/tree/3.2.2) |
| sharp | 0.34.5 | Apache-2.0; bundled libvips and native components retain their own licenses. [Repository](https://github.com/lovell/sharp) |
| JSZip | 3.10.1 | MIT OR GPL-3.0-or-later; project uses MIT option. [License](https://github.com/Stuk/jszip/blob/v3.10.1/LICENSE.markdown) |
| cheerio | 1.0.0 | MIT. [Repository](https://github.com/cheeriojs/cheerio/tree/v1.0.0) |
| @xmldom/xmldom | 0.9.12 override | MIT; maintained patch pinned for MathJax speech-rule-engine dependency. [Repository](https://github.com/xmldom/xmldom) |

Pandoc is called as an external executable. If redistributing that executable, comply with its license and provide the corresponding license/source requirements. This repository's setup script downloads it from the official release instead.
