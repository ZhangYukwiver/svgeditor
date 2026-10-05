/*
 * VectorLite Illustrator bridge
 * Target: Adobe Illustrator CC (tested against Illustrator 2025 / 29.x)
 *
 * The desktop host sets these environment variables before running the script:
 *   VECTORLITE_BRIDGE_COMMAND = report | open | export-svg | save-ai
 *   VECTORLITE_INPUT          = source .ai/.svg path (for open)
 *   VECTORLITE_OUTPUT         = destination report/.svg/.ai path
 *
 * This script deliberately lets Illustrator parse and save the native format.
 * It does not attempt to reimplement the private .ai file format.
 */
#target illustrator

(function () {
  function env(name) {
    try { return $.getenv(name) || ''; } catch (error) { return ''; }
  }

  function filePath(value) {
    if (!value) return null;
    return new File(value);
  }

  function escapeJson(value) {
    return String(value == null ? '' : value)
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\r/g, '\\r')
      .replace(/\n/g, '\\n');
  }

  function writeText(file, text) {
    if (!file) return;
    file.encoding = 'UTF-8';
    file.open('w');
    file.write(text);
    file.close();
  }

  function pointArray(point) {
    return '[' + Number(point[0]).toFixed(3) + ',' + Number(point[1]).toFixed(3) + ']';
  }

  function itemRecord(item, index) {
    var record = '{"index":' + index + ',"typename":"' + escapeJson(item.typename) + '"';
    try { record += ',"name":"' + escapeJson(item.name) + '"'; } catch (error) {}
    try { record += ',"visible":' + (item.hidden ? 'false' : 'true'); } catch (error) {}
    try { record += ',"locked":' + (item.locked ? 'true' : 'false'); } catch (error) {}
    try {
      if (item.typename === 'PathItem') {
        record += ',"closed":' + (item.closed ? 'true' : 'false');
        record += ',"points":[';
        for (var p = 0; p < item.pathPoints.length; p++) {
          if (p) record += ',';
          record += pointArray(item.pathPoints[p].anchor);
        }
        record += ']';
      } else if (item.typename === 'TextFrame') {
        record += ',"contents":"' + escapeJson(item.contents) + '"';
        record += ',"kind":"' + escapeJson(item.kind) + '"';
      }
    } catch (error) {
      record += ',"readError":"' + escapeJson(error.message || error) + '"';
    }
    return record + '}';
  }

  function reportDocument(doc, output) {
    var rect = doc.artboards[0].artboardRect;
    var report = '{"name":"' + escapeJson(doc.name) + '","fullName":"' + escapeJson(doc.fullName) + '"';
    report += ',"artboard":{"left":' + rect[0] + ',"top":' + rect[1] + ',"right":' + rect[2] + ',"bottom":' + rect[3] + '}';
    report += ',"pageItems":[';
    for (var i = 0; i < doc.pageItems.length; i++) {
      if (i) report += ',';
      report += itemRecord(doc.pageItems[i], i);
    }
    report += ']}';
    writeText(filePath(output) || new File(Folder.temp.fsName + '/vectorlite-illustrator-report.json'), report);
  }

  function exportSvg(doc, output) {
    var options = new ExportOptionsSVG();
    options.embedRasterImages = true;
    options.fontSubsetting = SVGFontSubsetting.GLYPHSUSED;
    options.coordinateSystem = SVGCoordinateSystem.ARTBOARDCOORDINATESYSTEM;
    options.saveMultipleArtboards = false;
    doc.exportFile(filePath(output), ExportType.SVG, options);
  }

  function saveAi(doc, output) {
    var options = new IllustratorSaveOptions();
    options.pdfCompatible = true;
    options.embedICCProfile = true;
    doc.saveAs(filePath(output), options);
  }

  function run() {
    var command = env('VECTORLITE_BRIDGE_COMMAND') || 'report';
    var input = env('VECTORLITE_INPUT');
    var output = env('VECTORLITE_OUTPUT');
    var doc = app.documents.length ? app.activeDocument : null;

    if (command === 'open') {
      if (!input) throw new Error('VECTORLITE_INPUT is required for open');
      doc = app.open(filePath(input));
    }
    if (!doc) throw new Error('No Illustrator document is open');
    if (command === 'export-svg') exportSvg(doc, output);
    else if (command === 'save-ai') saveAi(doc, output);
    else reportDocument(doc, output);
  }

  try {
    run();
  } catch (error) {
    var errorFile = filePath(env('VECTORLITE_OUTPUT')) || new File(Folder.temp.fsName + '/vectorlite-illustrator-error.txt');
    writeText(errorFile, 'VectorLite Illustrator bridge error\n' + (error.message || error));
    throw error;
  }
}());
