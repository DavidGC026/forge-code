export function defineForgeTheme(monaco: typeof import('monaco-editor')) {
  // Forge-dark theme — brick-red primary palette.
  // Color reference:
  //   Crimson  #E05A68 — primary accent / cursor / active editor chrome
  //   Clay     #D06A55 — keywords / HTML tags / control flow
  //   Rose     #C98575 — strings / attribute values / properties
  //   Light    #ABB2BF — variables / identifiers / default text
  //   Gray     #858B98 — comments
  //   Teal     #73C6B6 — functions / methods (cool contrast)
  //   Orange   #D19A66 — numbers / constants
  //   Yellow-2 #E5C07B — types / classes (warm contrast)
  //   White    #D0D3DA — operators / punctuation / delimiters
  monaco.editor.defineTheme('forge-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      // Default text
      { token: '', foreground: 'ABB2BF', background: '252830' },

      // Comments — gray (kept neutral for contrast)
      { token: 'comment', foreground: '858B98', fontStyle: 'italic' },
      { token: 'comment.html', foreground: '858B98', fontStyle: 'italic' },
      { token: 'comment.block', foreground: '858B98', fontStyle: 'italic' },
      { token: 'comment.line', foreground: '858B98', fontStyle: 'italic' },

      // Keywords — clay red (control flow, declarations)
      { token: 'keyword', foreground: 'D06A55' },
      { token: 'keyword.control', foreground: 'D06A55' },
      { token: 'keyword.operator', foreground: 'D0D3DA' },
      { token: 'storage', foreground: 'D06A55' },
      { token: 'storage.type', foreground: 'D06A55' },
      { token: 'storage.modifier', foreground: 'D06A55' },

      // HTML / XML / template tags — clay red
      { token: 'tag', foreground: 'D06A55' },
      { token: 'tag.html', foreground: 'D06A55' },
      { token: 'tag.xml', foreground: 'D06A55' },
      { token: 'metatag', foreground: 'D06A55' },
      { token: 'metatag.content.html', foreground: 'D06A55' },
      { token: 'metatag.html', foreground: 'D06A55' },
      { token: 'metatag.xml', foreground: 'D06A55' },

      // Attributes / properties / keys — softer rose brick
      { token: 'attribute.name', foreground: 'C98575' },
      { token: 'attribute.name.html', foreground: 'C98575' },
      { token: 'tag.attribute.name', foreground: 'C98575' },
      { token: 'attribute.name.css', foreground: 'C98575' },
      { token: 'property', foreground: 'C98575' },
      { token: 'property.json', foreground: 'C98575' },
      { token: 'key', foreground: 'C98575' },
      { token: 'key.json', foreground: 'C98575' },

      // Strings / attribute values — softer rose brick
      { token: 'string', foreground: 'C98575' },
      { token: 'string.html', foreground: 'C98575' },
      { token: 'string.value', foreground: 'C98575' },
      { token: 'string.quote', foreground: 'C98575' },
      { token: 'string.escape', foreground: 'C98575' },
      { token: 'attribute.value', foreground: 'C98575' },
      { token: 'attribute.value.html', foreground: 'C98575' },
      { token: 'attribute.value.xml', foreground: 'C98575' },
      { token: 'string.value.json', foreground: 'C98575' },
      { token: 'regexp', foreground: 'C98575' },

      // Template / delimiters — neutral white (so red tokens pop)
      // (covers Liquid/Jinja {% %} {{ }} as well as generic delimiters)
      { token: 'delimiter', foreground: 'D0D3DA' },
      { token: 'delimiter.html', foreground: 'D0D3DA' },
      { token: 'delimiter.xml', foreground: 'D0D3DA' },
      { token: 'delimiter.bracket', foreground: 'D0D3DA' },
      { token: 'delimiter.parenthesis', foreground: 'D0D3DA' },
      { token: 'delimiter.square', foreground: 'D0D3DA' },
      { token: 'delimiter.curly', foreground: 'D0D3DA' },
      { token: 'delimiter.angle', foreground: 'D0D3DA' },
      { token: 'delimiter.template', foreground: 'D06A55' },
      { token: 'meta.tag.template', foreground: 'D06A55' },
      { token: 'string.template', foreground: 'C98575' },
      { token: 'punctuation.definition.template', foreground: 'D06A55' },

      // Variables / identifiers — light (keep readable for contrast)
      { token: 'identifier', foreground: 'ABB2BF' },
      { token: 'variable', foreground: 'ABB2BF' },
      { token: 'variable.parameter', foreground: 'ABB2BF' },
      { token: 'variable.other', foreground: 'ABB2BF' },
      { token: 'variable.predefined', foreground: 'ABB2BF' },

      // Functions / methods — cool contrast against the brick palette
      { token: 'function', foreground: '73C6B6' },
      { token: 'support.function', foreground: '73C6B6' },
      { token: 'entity.name.function', foreground: '73C6B6' },
      { token: 'method', foreground: '73C6B6' },

      // Numbers — orange (warm contrast)
      { token: 'number', foreground: 'D19A66' },
      { token: 'number.hex', foreground: 'D19A66' },
      { token: 'number.float', foreground: 'D19A66' },
      { token: 'constant.numeric', foreground: 'D19A66' },
      { token: 'constant', foreground: 'D19A66' },
      { token: 'constant.language', foreground: 'D19A66' },

      // Types / classes — warm yellow (contrast against red keywords)
      { token: 'type', foreground: 'E5C07B' },
      { token: 'type.identifier', foreground: 'E5C07B' },
      { token: 'class', foreground: 'E5C07B' },
      { token: 'entity.name.class', foreground: 'E5C07B' },
      { token: 'entity.name.type', foreground: 'E5C07B' },
      { token: 'support.class', foreground: 'E5C07B' },
      { token: 'support.type', foreground: 'E5C07B' },
      { token: 'namespace', foreground: 'E5C07B' },

      // Operators — white
      { token: 'operator', foreground: 'D0D3DA' },
      { token: 'operator.sql', foreground: 'D0D3DA' },

      // CSS-specific
      { token: 'attribute.value.css', foreground: 'C98575' },
      { token: 'attribute.value.unit.css', foreground: 'D19A66' },
      { token: 'attribute.value.number.css', foreground: 'D19A66' },
      { token: 'attribute.value.hex.css', foreground: 'D19A66' },

      // Markdown
      { token: 'emphasis', fontStyle: 'italic' },
      { token: 'strong', fontStyle: 'bold' },

      // Errors
      { token: 'invalid', foreground: 'FF5370' },
    ],
    colors: {
      // Editor surface
      'editor.background': '#252830',
      'editor.foreground': '#ABB2BF',

      // Cursor & selection
      'editorCursor.foreground': '#E05A68',
      'editor.selectionBackground': '#3E4451',
      'editor.inactiveSelectionBackground': '#3E445199',
      'editor.selectionHighlightBackground': '#3E445166',
      'editor.wordHighlightBackground': '#3E445166',
      'editor.wordHighlightStrongBackground': '#3E445188',
      'editor.findMatchBackground': '#E05A6844',
      'editor.findMatchHighlightBackground': '#E05A6822',

      // Line numbers / gutter
      'editorLineNumber.foreground': '#636D83',
      'editorLineNumber.activeForeground': '#ABB2BF',
      'editorGutter.background': '#252830',

      // Current line
      'editor.lineHighlightBackground': '#FFFFFF08',
      'editor.lineHighlightBorder': '#00000000',

      // Whitespace / indent guides
      'editorWhitespace.foreground': '#3A3F4B',
      'editorIndentGuide.background': '#3A3F4B',
      'editorIndentGuide.activeBackground': '#E05A6866',

      // Bracket matching
      'editorBracketMatch.background': '#E05A6822',
      'editorBracketMatch.border': '#E05A6888',

      // Widgets
      'editorWidget.background': '#24282E',
      'editorWidget.border': '#3A3F4B',
      'editorSuggestWidget.background': '#24282E',
      'editorSuggestWidget.border': '#3A3F4B',
      'editorSuggestWidget.selectedBackground': '#3E4451',
      'editorSuggestWidget.highlightForeground': '#E05A68',
      'editorHoverWidget.background': '#24282E',
      'editorHoverWidget.border': '#3A3F4B',

      // Scrollbars
      'scrollbarSlider.background': '#FFFFFF14',
      'scrollbarSlider.hoverBackground': '#FFFFFF22',
      'scrollbarSlider.activeBackground': '#FFFFFF33',

      // Minimap / overview
      'minimap.background': '#252830',
      'editorOverviewRuler.border': '#252830',
    },
  });
}

