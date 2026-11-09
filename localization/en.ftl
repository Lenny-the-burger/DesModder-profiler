# File Conventions:
# Everything related to a plugin starts with the ID of the plugin
# Hardcoded in the Typescript:
# [pluginID]-name = Name
# [pluginID]-desc = Description
# [pluginID]-opt-[optionKey]-name = Option Name
# [pluginID]-opt-[optionKey]-desc = Option Description

## General
menu-learn-more = Learn more
menu-desmodder-plugins = DesModder Plugins
menu-desmodder-tooltip = DesModder Menu

## Category names
category-core-name = Core
category-utility-name = Utility
category-visual-name = Visual
category-integrations-name = Integrations

## GLesmos
GLesmos-name = GLesmos
GLesmos-desc = Render implicits on the GPU. Can cause the UI to slow down or freeze in rare cases; reload the page if you have issues.
GLesmos-label-toggle-glesmos = Render with GLesmos
GLesmos-confirm-lines = Confirm lines
GLesmos-confirm-lines-body = GLesmos line rendering can be slow. Be careful, especially for a list of layers.
GLesmos-no-support = Unfortunately, your browser does not support GLesmos because it does not support WebGL2.
GLesmos-not-enabled = Enable the GLesmos plugin to improve the performance of some implicits in this graph.
# Missing: error messages

## Tips
show-tips-name = Show Tips
show-tips-desc = Show tips at the bottom of the expressions list
show-tips-tip-export-videos = When exporting videos, prefer MP4 or APNG over GIF
show-tips-tip-disable-graphpaper = Disabling graphpaper in Calculator Settings is useful for writing a sequence of equations
show-tips-tip-paste-asciimath = Paste ASCII Math directly into Desmos
show-tips-tip-pin = Pin (bookmark) commonly-used expressions for easy access
show-tips-tip-long-video-capture = Before starting a long video capture, it's safest to test the beginning of an export
show-tips-tip-find-replace = Find and Replace is great for renaming variables
show-tips-tip-duplicate = Press Ctrl+Q or Ctrl+Shift+Q to duplicate the current expression
show-tips-tip-note-newline = Type Shift+Enter inside notes and folder titles for a newline
show-tips-tip-hide-errors = Click the yellow triangle (or type Shift+Enter) to fade a warning and hide sliders
show-tips-tip-note-folder = Type " to quickly make a note or "folder" for a folder
show-tips-tip-arctan = Use arctan(y, x) instead of arctan(y / x) to get the angle of a point
show-tips-tip-indefinite-integral = Integrals can have infinite bounds
show-tips-tip-random = The random function can sample from a distribution
show-tips-tip-two-argument-round = Two-argument round is great for rounding labels
show-tips-tip-two-argument-sort = Sort one list using keys of another list with sort(A, B)
show-tips-tip-custom-colors = Create custom colors with the functions rgb and hsv
show-tips-tip-ctrl-f = Press Ctrl+F to search through expressions
show-tips-tip-derivatives = Take derivatives using prime notation or Leibniz notation
show-tips-tip-unbounded-list-slices = List slices do not have to be bounded
show-tips-tip-dataviz-plots = To visualize data, you can use a histogram, boxplot, and more
show-tips-tip-statistics = Desmos has many built-in statistics functions
show-tips-tip-table-draggable-points = Use a table for a list of draggable points
show-tips-tip-polygon = Use the polygon function for easy polygons
show-tips-tip-point-arithmetic = Point (vector) arithmetic works as expected (e.g. (1, 2) + (3, 4) is (4, 6))
show-tips-tip-shift-drag = Shift-mouse drag over an axis to scale only that axis
show-tips-tip-action-ticker = Use actions and tickers to run simulations
show-tips-tip-latex-copy-paste = The math from Desmos can be directly copy-pasted into LaTeX editors
show-tips-tip-time-in-worker = To test how fast your graph runs, use ?timeInWorker or enable the Performance Display plugin
show-tips-tip-format-labels = Use backticks to math-format point labels
show-tips-tip-dynamic-labels = Use ${"{"} {"}"} for dynamic point labels based on a variable
show-tips-tip-disable-text-outline = Disabling text outline can sometimes make labels more readable
show-tips-tip-regression-power = Regressions are more powerful than you can imagine
show-tips-tip-spreadsheet-table = Paste spreadsheet data to make a table
show-tips-tip-keyboard-shortcuts = Type Ctrl+/ or Cmd+/ to open the list of keyboard shortcuts
show-tips-tip-listcomps = List comprehensions are great for grids of points or lists of polygons
show-tips-tip-list-filters = List filters can be used to filter for positive elements, even elements, and more
show-tips-tip-bernard = Bernard
show-tips-tip-new-desmos = What's new at Desmos
show-tips-tip-simultaneous-actions = Action assignments are simultaneous, not sequential
show-tips-tip-share-permalink = You can share graphs via permalink without signing in
show-tips-tip-point-coordinate = Extract the x or y coordinate of points by appending .x or .y to your point variable
show-tips-tip-audiotrace = Listen to your graphs using Audio Trace!
show-tips-tip-audiotrace-note-frequency = Note frequencies for audio trace depend on how high or low they are located in the viewport
show-tips-tip-audiotrace-range = Audio Trace range starts on an E4 (329.63 Hz) and ends on E5 (659.25 Hz)
show-tips-tip-other-calculators = Desmos also has other calculators!
show-tips-tip-lock-viewport = Don't want your viewport to be moved? Lock it in the graph settings!
show-tips-tip-glesmos = Enable the GLesmos plugin to make some implicits run faster
show-tips-tip-disable-show-tips = Tired of seeing me? Disable the "Show Tips" plugin in the Desmodder settings
show-tips-tip-compact-view-multiline = Sick of scrolling the expressions panel? Try enabling Compact View and/or Multiline Expressions to see more at once
show-tips-tip-intellisense = Too many long variable names? Enable Intellisense to make dealing with them easier
show-tips-tip-youre-doing-great = You're doing great :)
show-tips-tip-youre-superb = You're superb <3
show-tips-tip-huggy = Huggy!

## Text Mode
text-mode-name = Text Mode BETA
text-mode-desc = Expect bugs. Temporary documentation:
text-mode-toggle = Toggle Text Mode
text-mode-toggle-spaces = Spaces
text-mode-toggle-spaces-tooltip = Include unnecessary spaces when formatting
text-mode-toggle-newlines = Newlines
text-mode-toggle-newlines-tooltip = Include newlines and indentation when formatting
text-mode-format = Format

## Find and Replace
find-and-replace-name = Find and Replace
find-and-replace-desc = Adds a "replace all" button in the Ctrl+F Menu to let you easily refactor variable/function names.
find-and-replace-replace-all = replace all

## Wolfram To Desmos
wolfram2desmos-name = Wolfram To Desmos
wolfram2desmos-desc = Lets you paste ASCII Math (such as the results of Wolfram Alpha queries) into Desmos.
wolfram2desmos-opt-reciprocalExponents2Surds-name = Radical Notation
wolfram2desmos-opt-reciprocalExponents2Surds-desc = Converts fractional powers less than one to a radical equivalent (surd)
wolfram2desmos-opt-derivativeLoopLimit-name = Expand Derivatives
wolfram2desmos-opt-derivativeLoopLimit-desc = Expands the nth derivative of Leibniz notation into repeated derivatives (limited to 10).

## Pin Expressions
pin-expressions-name = Pin Expressions
pin-expressions-desc = Pin expressions from Edit List mode
pin-expressions-pin = Pin
pin-expressions-unpin = Unpin

## Builtin Settings
builtin-settings-name = Calculator Settings
builtin-settings-desc = Lets you toggle features built-in to Desmos. Most options apply only to your own browser and are ignored when you share graphs with others.
builtin-settings-opt-advancedStyling-name = Advanced styling
builtin-settings-opt-advancedStyling-desc = Enable label editing, show-on-hover, text outline, and one-quadrant grid
builtin-settings-opt-graphpaper-name = Graphpaper
builtin-settings-opt-graphpaper-desc = {""}
builtin-settings-opt-authorFeatures-name = Author features
builtin-settings-opt-authorFeatures-desc = Toggle hidden folders, toggle readonly, and more
builtin-settings-opt-pointsOfInterest-name = Show points of interest
builtin-settings-opt-pointsOfInterest-desc = Intercepts, holes, intersections, etc.
builtin-settings-opt-trace-name = Trace along curves
builtin-settings-opt-trace-desc = {""}
builtin-settings-opt-expressions-name = Show Expressions
builtin-settings-opt-expressions-desc = {""}
builtin-settings-opt-zoomButtons-name = Show Zoom Buttons
builtin-settings-opt-zoomButtons-desc = {""}
builtin-settings-opt-keypad-name = Show keypad
builtin-settings-opt-keypad-desc = {""}
builtin-settings-opt-showPerformanceMeter-name = Show performance meter
builtin-settings-opt-showPerformanceMeter-desc = {""}
builtin-settings-opt-showIDs-name = Show IDs
builtin-settings-opt-showIDs-desc = {""}

## Duplicate Expression Hotkey
duplicate-expression-hotkey-name = Duplicate Expression Hotkey
duplicate-expression-hotkey-desc = Type Ctrl+Q or Ctrl+Shift+Q to duplicate the selected expression.

## Right Click Tray
right-click-tray-name = Right Click Tray
right-click-tray-desc = Allows settings tray to be opened with a right click instead of holding left click on the settings bubble

## Scroll Beyond Last Line
scroll-beyond-name = Scroll Beyond Last Line
scroll-beyond-desc = When enabled, the expression list will scroll beyond the last line.

## Set Primary Color
set-primary-color-name = Set Primary Color
set-primary-color-desc = Choose the primary color for the user interface
set-primary-color-opt-primaryColor-name = Primary Color
set-primary-color-opt-primaryColor-desc = Primary color across the calculator
set-primary-color-opt-doFavicon-name = Update Site Icon
set-primary-color-opt-doFavicon-desc = Toggle updating the site icon

## Hide Errors
hide-errors-name = Hide Errors
hide-errors-desc = Shift-click error triangles to fade them and hide suggested sliders.
hide-errors-hide = hide

## Folder Tools
folder-tools-name = Folder Tools
folder-tools-desc = Adds buttons in edit-list-mode to help manage folders.
folder-tools-dump = Dump
folder-tools-merge = Merge
folder-tools-enclose = Enclose

## Video Creator
video-creator-name = Video Creator
video-creator-desc = Lets you export videos and GIFs of your graphs based on actions or sliders.
video-creator-menu = Video Creator Menu
video-creator-to = to
video-creator-step = , step
video-creator-ticks-playing-sliders = Playing sliders:
video-creator-ticks-step = Time step (ms):
video-creator-prev-action = Prev
video-creator-next-action = Next
video-creator-orientation = Orientation
video-creator-orientation-mode-current-speed = current
video-creator-orientation-mode-current-delta = step
video-creator-orientation-mode-from-to = from/to
video-creator-size = Size:
video-creator-mosaic = Mosaic:
video-creator-angle-current = Angle:
video-creator-angle-from = From:
video-creator-angle-to = To:
video-creator-angle-step = Step:
video-creator-angle-speed = Speed:
video-creator-step-count = Step count:
video-creator-frame-count = Frame count:
video-creator-target-same-pixel-ratio = Target same pixel ratio
video-creator-fast-screenshot = Fast captures
video-creator-target-tooltip = Adjusts scaling of line width, point size, label size, etc.
video-creator-ffmpeg-loading = FFmpeg loading...
video-creator-ffmpeg-fail = If this doesn't work in the next few seconds, try reloading the page or reporting this bug to DesModder devs.
video-creator-exporting = Exporting...
video-creator-cancel-capture = Cancel
video-creator-cancel-export = Cancel
video-creator-capture = Capture
video-creator-preview = Preview
video-creator-delete-all = Delete all
video-creator-filename-placeholder = set a filename
video-creator-export = Export
video-creator-export-as = Export as { $fileType }
video-creator-fps = FPS:
video-creator-method-once = once
video-creator-method-ntimes = count
video-creator-method-slider = slider
video-creator-method-action = action
video-creator-method-ticks = ticks

## Wakatime
wakatime-name = WakaTime
wakatime-desc = Track your desmos activity on WakaTime.com
wakatime-opt-secretKey-name = Secret Key
wakatime-opt-secretKey-desc = API Key used for WakaTime servers
wakatime-opt-splitProjects-name = Split Projects by Graph
wakatime-opt-splitProjects-desc = Store each graph as its own project instead of branches of a unified Desmos Project
wakatime-opt-projectName-name = Project name
wakatime-opt-projectName-desc = Visible from WakaTime, and shared for all Desmos projects

## Performance Display
performance-info-name = Performance Display
performance-info-desc = Displays information about the performance of the current graph.
performance-info-refresh-graph = Refresh Graph
performance-info-refresh-graph-tooltip = Refresh the graph to test initial load time
performance-info-sticky-tooltip = Keep menu open
performance-info-time-in-worker = Time In Worker
performance-info-compiling = Compiling
performance-info-rendering = Rendering
performance-info-other = Other

## Profiler
profiler-name = Profiler
profiler-desc = Measures how long each expression takes to compile, graph, draw, and compile shaders, including definitions used inside other expressions.
profiler-record = Record
profiler-stop = Stop
profiler-pin-tooltip = Keep open while you use the graph
profiler-record-load = Profile graph load
profiler-record-load-tooltip = Start recording and reload the graph, to measure how long it takes to open
profiler-opt-nodeBreakdown-name = Break Down Expressions
profiler-opt-nodeBreakdown-desc = Time each part of every expression while it compiles, shown in the flame graph. Makes compiling slower while recording.
profiler-opt-gpuTiming-name = Measure GPU Time
profiler-opt-gpuTiming-desc = In 3D, time each draw on the GPU. Adds a little overhead while recording.
profiler-empty = Press Record, then use the graph: edit expressions, drag sliders, or rotate the view. Open this menu again to stop. Or profile a fresh load of the whole graph.
profiler-empty-recording = Recording. Interact with the graph, then press Stop.
profiler-status-recording = Recording
profiler-status-duration = { $duration }
profiler-status-updates = { $count ->
    [one] 1 update
   *[other] { $count } updates
}
profiler-status-frames = { $count ->
    [one] 1 3D frame
   *[other] { $count } 3D frames
}
profiler-tabs-label = Profiler view
profiler-tab-expressions = Expressions
profiler-tab-definitions = Definitions
profiler-segment-parse = Parse
profiler-segment-parse-tooltip = Reading the expression's LaTeX into a form Desmos can compile
profiler-segment-compile = Compile
profiler-segment-compile-tooltip = Compiling the expression, including the definitions it uses and any constants it folds
profiler-segment-graph = Graph
profiler-segment-graph-tooltip = Computing what to plot: sampling curves, meshing surfaces, and solving implicits
profiler-segment-draw = Draw
profiler-segment-draw-tooltip = Drawing the plot on screen (CPU time)
profiler-segment-shader = Shaders
profiler-segment-shader-tooltip = Setting up 3D shaders, mostly waiting for new shaders to compile
profiler-segment-other = Other
profiler-segment-other-tooltip = Other work Desmos does each frame, such as updating labels and expression statuses
profiler-overview-average = Average frame
profiler-overview-frames = { $count ->
    [one] over 1 frame
   *[other] over { $count } frames
}
profiler-overview-average-tooltip = CPU time per frame, added up across Desmos's threads. A frame is one update of the graph and the redraw that follows it.
profiler-overview-hint = Each block is one expression, colored by where most of its time goes. Hover to see it, click to go to it.
profiler-overview-segment = { $name } · { $duration } ({ $percent }) · mostly { $category }
profiler-overview-rest = { $count ->
    [one] 1 smaller expression
   *[other] { $count } smaller expressions
} · { $duration } ({ $percent })
profiler-row-stats = median of { $count ->
    [one] 1 frame
   *[other] { $count } frames
} · { $total } total
profiler-row-time-tooltip = Median time per frame in which this expression did work
profiler-segment-gpu = GPU
profiler-segment-gpu-tooltip = Time the GPU spent drawing (runs alongside the CPU)
profiler-no-expressions = Nothing measurable was recorded for any expression.
profiler-unknown-expression = Deleted expression ({ $id })
profiler-badge-shader-compiles = { $count ->
    [one] 1 new shader
   *[other] { $count } new shaders
}
profiler-badge-shader-wait = waited { $duration } for shader compile
profiler-badge-error = error
profiler-definitions-explainer = Desmos compiles a definition again inside every expression that uses it. This is the compile time each definition added, summed over every use.
profiler-no-definitions = No definitions were compiled while recording.
profiler-definition-uses = compiled { $compiles ->
    [one] once
   *[other] { $compiles } times
} in { $exprs ->
    [one] 1 expression
   *[other] { $exprs } expressions
}
profiler-definition-hits = { $count } reused
profiler-definition-tooltip = { $self } on its own, { $inclusive } including definitions it uses
profiler-wackscope = wackscope
profiler-wackscope-tooltip = Errors on its own, but works inside other expressions that provide the missing variables
profiler-show-all = Show all { $count }
profiler-show-less = Show less
profiler-unattributed = Not tied to an expression
profiler-other = Other
profiler-3d = 3D
profiler-open-flame = Open flame graph
profiler-flame-title = Flame graph
profiler-flame-root-cpu = All CPU time
profiler-flame-root-gpu = All GPU time
profiler-flame-cpu = CPU
profiler-flame-gpu = GPU
profiler-flame-metric-label = Time measured
profiler-flame-group-phase = By phase
profiler-flame-group-expression = By expression
profiler-flame-group-label = Group by
profiler-flame-other-worker = Other worker work
profiler-flame-shader-wait = Waiting for shader compile
profiler-flame-search = Highlight
profiler-flame-close = Close flame graph
profiler-flame-empty = Nothing recorded yet. Record in the Profiler menu, then come back here.
profiler-flame-matched = Highlighted: { $duration } ({ $percent })
profiler-flame-of-total = { $percent } of total
profiler-flame-of-parent = { $percent } of parent
profiler-flame-self = { $duration } self
profiler-flame-compiled = compiled { $count ->
    [one] once
   *[other] { $count } times
}
profiler-flame-jump-expression = Show expression
profiler-flame-jump-definition = Show definition

## Better Evaluation View
better-evaluation-view-name = Better Evaluation View
better-evaluation-view-desc = Displays list elements, colors, and undefined values
better-evaluation-view-evaluation-list = { $count } element list
better-evaluation-view-opt-floats-name = Advanced floating point
better-evaluation-view-opt-floats-desc = Show NaN/∞/-∞ instead of undefined, and '-0' for negative 0.
better-evaluation-view-opt-lists-name = Show list elements
better-evaluation-view-opt-lists-desc = Show list elements instead of list length
better-evaluation-view-opt-lists-old = Variant
better-evaluation-view-opt-lists-new = Default
better-evaluation-view-opt-lists-length = Count
better-evaluation-view-opt-colors-name = Show colors
better-evaluation-view-opt-colors-desc = Show colors as rgb values
better-evaluation-view-opt-colorLists-name = Show lists of colors
better-evaluation-view-opt-colorLists-desc = Show lists of colors as lists of rgb values
better-evaluation-view-opt-fractions-name = Better Fractions
better-evaluation-view-opt-fractions-desc = Show the decimal → fraction toggle for matrices and lists of numbers

## Pillbox Menus
pillbox-menus-name = Pillbox Menus (Core)
pillbox-menus-desc = Show the buttons on the right side, such as the Video Creator or DesModder main menu

## Manage Metadata
manage-metadata-name = Manage Metadata (Core)
manage-metadata-desc = Manage Metadata, such as GLesmos or pinned/unpinned status

## Intellisense
intellisense-name = Intellisense
intellisense-desc = Brings several common IDE features to Desmos, including autocompletion suggestions, function call help, and jump to definition. Documentation here:
intellisense-opt-subscriptify-name = Auto-Subscriptify
intellisense-opt-subscriptify-desc = Automatically converts text of variables/functions with subscripts when they are typed without subscripts.
intellisense-jump2def-menu-instructions = has multiple definitions. Pick one from below to jump to.

## Compact View
compact-view-name = Compact View
compact-view-desc = Offers a variety of options for condensing the UI so you can see more on the screen at once.
compact-view-opt-textFontSize-name = Text Font Size
compact-view-opt-textFontSize-desc = Size of the font in notes
compact-view-opt-mathFontSize-name = Math Font Size
compact-view-opt-mathFontSize-desc = Size of the font in mathematical expressions
compact-view-opt-bracketFontSizeFactor-name = Bracket Multiplier
compact-view-opt-bracketFontSizeFactor-desc = Text inside of brackets (parentheses, curly braces, etc.) decreases in size by this factor.
compact-view-opt-minimumFontSize-name = Min Font Size
compact-view-opt-minimumFontSize-desc = Minimum possible math font size (overrides Bracket Font Size Factor)
compact-view-opt-compactFactor-name = Remove Spacing
compact-view-opt-compactFactor-desc = Removes lots of empty space in the expressions list.
compact-view-opt-hideFolderToggles-name = Hide Folder Toggles
compact-view-opt-hideFolderToggles-desc = Hides the folder toggles added to hide folders and bring to front.
compact-view-opt-noSeparatingLines-name = No Separating lines
compact-view-opt-noSeparatingLines-desc = Removes the separating lines between expressions and replaces them with alternating colors.
compact-view-opt-highlightAlternatingLines-name = Highlight Alternating Lines
compact-view-opt-highlightAlternatingLines-desc = Highlights alternating expressions so that they can be easily distinguished from one another.
compact-view-opt-hideEvaluations-name = Collapse Evaluations
compact-view-opt-hideEvaluations-desc = Puts evaluations off to the side. They can be focused or hovered to be shown.

## Multiline
multiline-name = Multiline Expressions
multiline-desc = Splits expressions onto multiple lines to better make use of available space.
multiline-opt-widthBeforeMultiline-name = Width Threshold (%)
multiline-opt-widthBeforeMultiline-desc = Minimum width (as a percent of the viewport size) at which point wrapping will occur. On mobile, this value is tripled.
multiline-opt-automaticallyMultilinify-name = Insert Linebreaks while Typing
multiline-opt-automaticallyMultilinify-desc = Automatically splits expressions onto multiple lines while you type, bypassing the need to use Ctrl+M.
multiline-opt-multilinifyDelayAfterEdit-name = Edit Delay (ms)
multiline-opt-multilinifyDelayAfterEdit-desc = Multiline expressions should be updated after no edits are made for this number of milliseconds.
multiline-opt-spacesToNewlines-name = Spaces to Newlines
multiline-opt-spacesToNewlines-desc = Convert groups of 3 spaces into newlines. These can be automatically created with Shift+Enter.
multiline-opt-determineLineBreaksAutomatically-name = Auto Insert Linebreaks
multiline-opt-determineLineBreaksAutomatically-desc = Automatically figure out where to put line breaks. Use Ctrl+M to trigger this.
multiline-opt-disableAutomaticLineBreaksForHandAlignedExpressions-name = Skip expressions with triple spaces
multiline-opt-disableAutomaticLineBreaksForHandAlignedExpressions-desc = Don't automatically insert extra line breaks in expressions that have any manually-added line breaks (triple spaces).

## Custom MathQuill Config
custom-mathquill-config-name = Custom MathQuill Config
custom-mathquill-config-desc = Changes how equation input works.
custom-mathquill-config-opt-superscriptOperators-name = Operators in Exponents
custom-mathquill-config-opt-superscriptOperators-desc = Allows you to type operators like "+" in exponents
custom-mathquill-config-opt-noAutoSubscript-name = Disable Auto Subscripts
custom-mathquill-config-opt-noAutoSubscript-desc = Disable automatically putting numbers typed after variable names in subscripts
custom-mathquill-config-opt-noNEquals-name = Disable n= Sums
custom-mathquill-config-opt-noNEquals-desc = Disable sums automatically placing "n=" in the lower bound
custom-mathquill-config-opt-subSupWithoutOp-name = Subscripts/Superscripts Without Operand
custom-mathquill-config-opt-subSupWithoutOp-desc = Allows subscripts and superscripts to be made even if not preceded by anything
custom-mathquill-config-opt-allowMixedBrackets-name = Allow Mismatched Brackets
custom-mathquill-config-opt-allowMixedBrackets-desc = Allows all brackets to match with each other (includes absolute value)
custom-mathquill-config-opt-subscriptReplacements-name = Allow Replacements in Subscripts
custom-mathquill-config-opt-subscriptReplacements-desc = Allows symbols and function names to be typed into subscripts
custom-mathquill-config-opt-noPercentOf-name = Disable % of
custom-mathquill-config-opt-noPercentOf-desc = Makes typing "%" insert the percent character instead of "% of"
custom-mathquill-config-opt-commaDelimiter-name = Comma Separators
custom-mathquill-config-opt-commaDelimiter-desc = Inserts commas as delimiters in numbers (purely visual)
custom-mathquill-config-opt-delimiterOverride-name = Custom Delimiter
custom-mathquill-config-opt-delimiterOverride-desc = Set the string to be used as number delimiters
custom-mathquill-config-opt-leftIntoSubscript-name = Left/Right into Subscripts
custom-mathquill-config-opt-leftIntoSubscript-desc = Moving the cursor left or right will go into subscript instead of superscript
custom-mathquill-config-opt-extendedGreek-name = More Greek Letters
custom-mathquill-config-opt-extendedGreek-desc = Enables replacements for all supported greek letters
custom-mathquill-config-opt-lessFSpacing-name = Less Spacing Around "f"
custom-mathquill-config-opt-lessFSpacing-desc = Reduces extra spacing around the letter "f"

## Code Golf
code-golf-name = Code Golf
code-golf-desc = Tools for helping Desmos Code Golfers. Press Alt+Q to enable/disable.
code-golf-width-in-pixels = Width: { $pixels } px
code-golf-symbol-count = Symbol Count: { $elements }
code-golf-click-to-enable-folder = Click to enable code golf stats.
code-golf-note-latex-byte-count = { $chars } LaTeX Bytes
code-golf-opt-showWidth-name = Show 'Width'
code-golf-opt-showWidth-desc = {""}
code-golf-opt-disableOnReload-name = Disable on reload.
code-golf-opt-disableOnReload-desc = {""}

## Syntax highlightAlternatingLines
syntax-highlighting-name = Syntax Highlighting
syntax-highlighting-desc = Color in various parts of expressions to make them easier to reason about.
syntax-highlighting-opt-bracketPairColorization-name = Bracket Pair Colorization
syntax-highlighting-opt-bracketPairColorization-desc = Applies a set of alternating colors to brackets (e.g. ()[]{"{"}{"}"}||) to make matching bracket pairs easy to spot.
syntax-highlighting-opt-bracketPairColorizationColors-name = Bracket Pair Colors
syntax-highlighting-opt-bracketPairColorizationColors-desc = Sets the number and order of colors that are used for bracket pair colorization.
syntax-highlighting-opt-bpcColorInText-name = Colorize Text in Brackets
syntax-highlighting-opt-bpcColorInText-desc = Applies Bracket Pair Colors to the text within the brackets.
syntax-highlighting-opt-thickenBrackets-name = Thicken Brackets
syntax-highlighting-opt-thickenBrackets-desc = Add additional thickness to brackets to assist in bracket colorization.
syntax-highlighting-opt-highlightBracketBlocks-name = Highlight Bracket Blocks
syntax-highlighting-opt-highlightBracketBlocks-desc = Highlight the smallest enclosing bracket pair containing the text cursor.
syntax-highlighting-opt-highlightBracketBlocksHover-name = Highlight on Hover
syntax-highlighting-opt-highlightBracketBlocksHover-desc = Highlight the smallest enclosing bracket pair containing the mouse.
syntax-highlighting-opt-underlineHighlightedRanges-name = Underline Highlighted Ranges
syntax-highlighting-opt-underlineHighlightedRanges-desc = Puts a dark underline under highlighted ranges for better visibility.

## Better Navigation
better-navigation-name = Better Navigation
better-navigation-desc = Tools for making Desmos expressions easier to navigate.
better-navigation-opt-ctrlArrow-name = Ctrl+Arrow Support
better-navigation-opt-ctrlArrow-desc = Use Ctrl+ArrowKeys or Ctrl+Shift+ArrowKeys to skip over large blocks of text quickly. Use Ctrl+Backspace to delete large blocks of text.
better-navigation-opt-scrollableExpressions-name = Scrollable Expressions
better-navigation-opt-scrollableExpressions-desc = Adds horizontal scrollbars to expressions. This is primarily intended to make scrolling easier on mobile.
better-navigation-opt-showScrollbar-name = Show Scrollbar
better-navigation-opt-showScrollbar-desc = Shows or hides scrollbar. It is convenient to turn this off for touch devices.

## Paste Image
paste-image-name = Paste Image
paste-image-desc = Lets you paste image files to import them at once.
paste-image-error-images-not-enabled = Image insertion is not enabled for this graph.
paste-image-error-another-upload-in-progress = Retry after another upload in progress is completed.

## Quake Pro
quake-pro-name = Quake Pro
quake-pro-desc = Allows you to increase the Field of View beyond the 3D calculator's regular limit.
quake-pro-opt-dollyMagnification-name = Dolly Multiplier
quake-pro-opt-dollyMagnification-desc = Heightens the zoom behavior by multiplying (dollying) the camera's viewport slider.
quake-pro-opt-scalarZoomed-name = Scalar Cancellation
quake-pro-opt-scalarZoomed-desc = Combats perspective distortion by multiplying (enlarging) the screen viewport (requires max zoom to be fully seen).

## Shader Inspector
shader-inspector-name = Shader Inspector
shader-inspector-desc = In 3D, shows what each surface's shader uses: uniform slots, cost, loops, and code, split by the expressions that put them there, and why it gets recompiled.
shader-inspector-pin = Keep open while you use the graph
shader-inspector-back = All shaders
shader-inspector-budget = { $budget } uniform slots per surface
shader-inspector-budget-tooltip = Sliders and other changeable values each take one slot (a point takes three). A surface's restriction and color function share the slots. Values past the limit are written into the shader, so changing them recompiles it.
shader-inspector-total-recompiles = { $count ->
    [one] 1 recompile
   *[other] { $count } recompiles
  }
shader-inspector-recompiles-short = { $count ->
    [one] recompiled once
   *[other] recompiled { $count }×
  }
shader-inspector-reset = Reset
shader-inspector-empty = No 3D shaders yet. Desmos makes shaders for color functions that use x, y, or z, and for restrictions on surfaces.
shader-inspector-pick = Pick a shader to inspect.
shader-inspector-gone = This shader isn't in the graph anymore.
shader-inspector-untraced = Desmos internals
shader-inspector-untraced-shader = Reload the graph to see which expressions each part of this shader comes from.
shader-inspector-uniforms = { $used } / { $budget } slots
shader-inspector-uniforms-head = { $used } / { $budget } slots{ $baked ->
    [0] {""}
   *[other] , { $baked } past the limit
}
shader-inspector-overflow = { $count } past the limit
shader-inspector-cost-short = cost { $cost }
shader-inspector-color-function = Color function:{" "}
shader-inspector-tile-slots = Uniform slots
shader-inspector-tile-cost = Cost estimate
shader-inspector-tile-steps = Loop steps per pixel
shader-inspector-tile-chars = GLSL characters
shader-inspector-tile-recompiles = Recompiles
shader-inspector-tile-programs = Shaders / surfaces
shader-inspector-section-uniforms = Uniform slots
shader-inspector-group-list = { $list }, { $slots } slots
shader-inspector-group-single = { $count ->
    [one] 1 value
   *[other] { $count } values
  }
shader-inspector-free = { $count } free
shader-inspector-singles = Single values, zoomed in: { $count ->
    [one] 1 slot
   *[other] { $count } slots
  }
shader-inspector-section-cost-restriction = Restriction cost
shader-inspector-section-cost-color = Color function cost
shader-inspector-section-loops = Sums, products, and list operations
shader-inspector-steps = { $steps } steps per pixel
shader-inspector-loop = { $terms } terms × { $body } cost each = { $cost } · runs { $runs }× per pixel
shader-inspector-loop-list = { $terms } elements × { $body } cost each = { $cost } · runs { $runs }× per pixel
shader-inspector-loop-terms-tooltip = { $terms } of at most { $limit } terms
shader-inspector-loops-caption = Each sum or product can have at most { $limit } terms. Nested ones multiply: the inner one runs once per term of the outer one, and its cost counts that many times.
shader-inspector-section-glsl = Generated GLSL
shader-inspector-glsl-share = { $chars } characters, { $lines ->
    [one] 1 line
   *[other] { $lines } lines
  }
shader-inspector-helpers = Helper functions: { $helpers }
shader-inspector-glsl-caption = Bigger shaders take longer to compile. Desmos adds its own lighting and helper code around this, the same for every surface.
shader-inspector-show-code = Show code
shader-inspector-hide-code = Hide code
shader-inspector-section-recompiles = Recompiles
shader-inspector-no-recompiles = No recompiles since the graph loaded or the counts were reset.
shader-inspector-panel-slots = { $count ->
    [one] 1 slot
   *[other] { $count } slots
  }
shader-inspector-panel-chars = { $count } GLSL characters
shader-inspector-panel-owner = The inspected shader
shader-inspector-panel-none = Used by the inspected shader
shader-inspector-reason-baked = Values past the limit changed ({ $count })
shader-inspector-reason-baked-tooltip = Values past the slot limit are written into the shader, so changing them makes a new shader.
shader-inspector-reason-list-length = A list changed length ({ $count })
shader-inspector-reason-list-length-tooltip = List lengths are part of the shader, so a list whose length depends on a slider recompiles whenever its length changes.
shader-inspector-reason-structure = The shader's code changed ({ $count })
shader-inspector-reason-structure-tooltip = An edit, or a piecewise whose condition only depends on sliders flipping between branches that use x, y, or z. Desmos only compiles the branch it picks.
shader-inspector-reason-constant = A typed number changed ({ $count })
shader-inspector-reason-constant-tooltip = Numbers typed into an expression are written into the shader. Use a slider instead to change it without recompiling.
shader-inspector-error-color-cost = Color function over the cost limit of 10,000. Nested sums multiply: each sum's terms times what's inside it.
shader-inspector-error-restriction-cost = Restriction over the cost limit of 10,000. Nested sums multiply: each sum's terms times what's inside it.
shader-inspector-error-inequality-cost = Inequality over the shader cost limit of 10,000.
shader-inspector-error-long-loop = A sum or product in a shader can have at most 1,000 terms. Each one is checked on its own, using current slider values.
shader-inspector-error-variable-loop = A sum or product in a shader needs bounds that don't depend on x, y, z or on another sum's index.
shader-inspector-error-list-size = Lists in shaders can have at most 100 elements.
shader-inspector-error-rejected = Desmos made this shader and then rejected it. Below is what it would have been.
shader-inspector-error-no-shader = Desmos stopped before making a shader, so there's nothing more to show.
shader-inspector-cost-help = How the cost is estimated
shader-inspector-cost-help-intro = Desmos estimates the work per pixel from the compiled instructions, before the shader is built. Over { $limit }, it refuses to build the shader. Each instruction that reaches the result adds:
shader-inspector-cost-row-free = Constants, uniforms, variable reads, restrictions
shader-inspector-cost-row-cheap = + − × ÷, negation, squaring, comparisons, and/or, piecewise, abs, sign, min, max, sqrt, building a 3D point
shader-inspector-cost-row-costly = Powers, trig and hyperbolic functions, exp, ln, log, floor, ceil, round, mod, hypot, distance, erf, factorial, color functions, complex math, list indexing, building tuples and taking coordinates
shader-inspector-cost-row-reduction = Reducing a list of length n: mean, total, min, max, median, argmin, argmax, stdev, var, gcd, lcm, sort (cov and corr use the shorter list)
shader-inspector-cost-row-list = A list written out with n elements
shader-inspector-cost-row-never = Integrals, map-style blocks, function calls that aren't inlined, distributions, and loops with bounds unknown at compile time: the shader can't be built
shader-inspector-cost-help-loops = A sum or product costs its number of terms × the cost of one run of its body; a list operation costs the list length × its body. Nested ones multiply, so a sum inside a sum grows fast.
shader-inspector-cost-row-heavy = Matrix operations: 9 to 300 each, up to 64 for multiplying
shader-inspector-node-shader = Shader
shader-inspector-part-restriction = Restriction
shader-inspector-part-color = Color function
shader-inspector-metric-cost = Cost
shader-inspector-metric-uniforms = Uniform slots
shader-inspector-metric-glsl = GLSL characters
shader-inspector-metric-loops = Loop steps
shader-inspector-unit-cost = cost { $value }
shader-inspector-unit-uniforms = { $value } slots
shader-inspector-unit-glsl = { $value } characters
shader-inspector-unit-loops = { $value } loop steps per pixel
shader-inspector-of-shader = { $percent } of the shader
shader-inspector-of-parent = { $percent } of the part it's in
shader-inspector-itself = { $value } by itself
shader-inspector-repeats = Cost { $total } = { $parts }
shader-inspector-cat-cost-never = Can't be in a shader
shader-inspector-cat-cost-reduction = List reductions (5 per element)
shader-inspector-cat-cost-list = Lists written out (1 per element)
shader-inspector-cat-cost-heavy = Matrix operations
shader-inspector-cat-cost-costly = Costly (5 each)
shader-inspector-cat-cost-cheap = Cheap (1 each)
shader-inspector-cat-cost-free = Free
shader-inspector-cat-uniforms-single = Single values
shader-inspector-cat-uniforms-list = List elements
shader-inspector-cat-uniforms-baked = Past the limit, written into the shader
shader-inspector-detail-hint = Highlighted parts are colored by what they add the most of. Click one to look inside it.
shader-inspector-detail-loop = { $kind }: { $terms } terms × { $body } cost each, runs { $runs }× per pixel
shader-inspector-loop-over = over { $over }
shader-inspector-loop-kind-sum = Sum
shader-inspector-loop-kind-product = Product
shader-inspector-loop-kind-list = List operation
shader-inspector-detail-lists = Lists: { $lists }
shader-inspector-parts = Parts
shader-inspector-inlined = from another expression
shader-inspector-go-to = Go to expression
shader-inspector-open-flame = Flame graph
shader-inspector-open-detail = Details
shader-inspector-open-detail-shader = Break it down
shader-inspector-untraced-detail = Code Desmos added that couldn't be traced to an expression.
shader-inspector-flame-title = Shader flame graph
shader-inspector-flame-metric = What to measure
shader-inspector-flame-close = Close
shader-inspector-flame-empty = Nothing in this shader adds to this.
shader-inspector-flame-hint = Hover over a bar to see what it adds. Click it to zoom in and see it in detail; Esc zooms back out.
shader-inspector-show-compiled = Show compiled code
shader-inspector-hide-compiled = Hide compiled code
