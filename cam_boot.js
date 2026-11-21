/**
 * CamMIDI boot — audio on + open video preview.
 */
autowatch = 1;
inlets = 1;
outlets = 2;

var PREVIEW = "CamMIDI_Preview.maxpat";
var PREVIEW_FULL =
  "D:/Dv/Repo/Android/MaxView/MaxCamInstrument/CamMIDI_Preview.maxpat";

function resolvePreview() {
  try {
    if (this.patcher && this.patcher.filepath) {
      var fp = String(this.patcher.filepath).replace(/\\/g, "/");
      var slash = fp.lastIndexOf("/");
      if (slash >= 0) return fp.substring(0, slash + 1) + PREVIEW;
    }
  } catch (e) {}
  return PREVIEW_FULL;
}

function do_openvideo() {
  var full = resolvePreview();
  post("[CamMIDI] video: " + full + "\n");
  try {
    max.openfile(PREVIEW, full);
  } catch (e1) {
    post("[CamMIDI] openfile: " + e1 + "\n");
  }
}

function audioon() {
  outlet(1, 1);
  try {
    if (typeof max.startaudio === "function") max.startaudio();
  } catch (e) {}
  outlet(0, "set", "audio OK · WinMIDI · cámara del sistema");
}

function bang() {
  audioon();
  do_openvideo();
}

function openvideo() {
  do_openvideo();
}

function open() {
  do_openvideo();
}
