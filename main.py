import os
import io
import json
import datetime as dt
import csv
from pathlib import Path
from flask import Flask, request, render_template, send_from_directory, jsonify

import pdfplumber

BASE_DIR = Path(__file__).parent.resolve()
LAYOUTS_DIR = BASE_DIR / "layouts"
OUTPUT_DIR = BASE_DIR / "output"

app = Flask(__name__, template_folder=str(BASE_DIR / "templates"), static_folder=str(BASE_DIR / "static"))
app.config["MAX_CONTENT_LENGTH"] = 50 * 1024 * 1024  # 50 MB


# ---------- Helpers ----------
def allowed_file(filename, ext):
    return '.' in filename and filename.lower().split('.')[-1] == ext.lower()


def extract_with_layout(layout_path: Path, pdf_file, output_writer):
    """Extract text for each box in layout."""
    layout = json.loads(layout_path.read_text(encoding='utf-8'))
    boxes = layout["boxes"]
    tpl_name = layout.get("template_name", layout_path.stem)

    with pdfplumber.open(pdf_file) as pdf:
        for box_id, box in enumerate(boxes, 1):
            page_index = box["page"]
            if page_index >= len(pdf.pages):
                continue
            page = pdf.pages[page_index]
            height = page.height
            width = page.width
            x0, y0 = box["x0"], box["bottom"]
            x1, y1 = box["x1"], box["top"]
            bbox = (box["x0"], box["top"], box["x1"], box["bottom"])
            # Skip if bbox is completely outside the page
            if (
                bbox[0] >= width or bbox[2] <= 0 or
                bbox[1] >= height or bbox[3] <= 0 or
                bbox[0] >= bbox[2] or bbox[1] >= bbox[3]
            ):
                continue
            try:
                txt = page.crop(bbox).extract_text(x_tolerance=1, y_tolerance=1) or ""
            except Exception:
                txt = ""
            output_writer.writerow({
                "file_name": pdf_file.filename if hasattr(pdf_file, "filename") else Path(pdf_file.name).name,
                "page": page_index,
                "box_id": box_id,
                "layout": tpl_name,
                "extracted_text": txt.strip().replace('\n', ' ')
            })


# ---------- Routes ----------
@app.route("/")
def index():
    return render_template("index.html")

@app.route("/list_layouts")
def list_layouts():
    files = [f.name for f in LAYOUTS_DIR.glob("*.json")]
    return jsonify(files)

@app.route("/save_layout", methods=["POST"])
def save_layout():
    data = request.get_json()
    if not data or "template_name" not in data:
        return {"error": "invalid payload"}, 400
    name = data["template_name"].strip().replace(' ', '_')
    fname = f"{name}.json"
    path = LAYOUTS_DIR / fname
    path.write_text(json.dumps(data, indent=2), encoding='utf-8')
    return {"status": "ok", "file": fname}

@app.route("/extract", methods=["POST"])
def extract():
    try:
        layout_name = request.form.get("layout")
        if not layout_name:
            return {"error": "layout is required"}, 400
        layout_path = LAYOUTS_DIR / layout_name
        if not layout_path.exists():
            return {"error": "layout not found"}, 404

        uploaded = request.files.getlist("files")
        if not uploaded:
            return {"error": "no PDFs"}, 400

        ts = dt.datetime.now().strftime("%Y%m%d_%H%M%S")
        out_txt_name = f"extracted_{ts}.txt"
        out_path = OUTPUT_DIR / out_txt_name
        OUTPUT_DIR.mkdir(exist_ok=True)

        with open(out_path, "w", encoding="utf-8") as txtfile:
            total_boxes = 0
            for f in uploaded:
                if not allowed_file(f.filename, "pdf"):
                    continue
                extracted = []
                layout = json.loads(layout_path.read_text(encoding='utf-8'))
                boxes = layout["boxes"]
                tpl_name = layout.get("template_name", layout_path.stem)
                with pdfplumber.open(f) as pdf:
                    for box_id, box in enumerate(boxes, 1):
                        page_index = box["page"]
                        if page_index >= len(pdf.pages):
                            continue
                        page = pdf.pages[page_index]
                        height = page.height
                        width = page.width
                        print(f"Processing file: {f.filename if hasattr(f, 'filename') else Path(f.name).name}")
                        print(f"Page {page_index}: width={width}, height={height}")
                        x0, y0 = box["x0"], box["bottom"]
                        x1, y1 = box["x1"], box["top"]
                        print(f"Box {box_id} raw: x0={x0}, x1={x1}, top={box['top']}, bottom={box['bottom']}")
                        # Try direct mapping (no Y flip)
                        bbox = (box["x0"], box["top"], box["x1"], box["bottom"])
                        print(f"Box {box_id} bbox: {bbox}")
                        if (
                            bbox[0] >= width or bbox[2] <= 0 or
                            bbox[1] >= height or bbox[3] <= 0 or
                            bbox[0] >= bbox[2] or bbox[1] >= bbox[3]
                        ):
                            print(f"Box {box_id} skipped: out of bounds.")
                            continue
                        try:
                            txt = page.crop(bbox).extract_text(x_tolerance=1, y_tolerance=1)
                        except Exception as e:
                            print(f"Box {box_id} extraction error: {e}")
                            txt = None
                        if txt is None or not txt.strip():
                            txt = "[NO TEXT FOUND]"
                        extracted.append(
                            f"File: {f.filename if hasattr(f, 'filename') else Path(f.name).name}\n"
                            f"Page: {page_index}\nBox: {box_id}\nLayout: {tpl_name}\nText: {txt.strip()}\n{'-'*40}\n"
                        )
                        total_boxes += 1
                txtfile.writelines(extracted)
            if total_boxes == 0:
                txtfile.write("No boxes were processed. Check your layout and PDF file compatibility.\n")

        return {"status": "ok", "txt": out_txt_name}
    except Exception as e:
        import traceback
        print(traceback.format_exc())
        return jsonify({"error": str(e), "trace": traceback.format_exc()}), 500

@app.route("/download/<path:filename>")
def download(filename):
    return send_from_directory(str(OUTPUT_DIR), filename, as_attachment=True)

if __name__ == "__main__":
    LAYOUTS_DIR.mkdir(exist_ok=True)
    OUTPUT_DIR.mkdir(exist_ok=True)
    app.run(debug=True)
