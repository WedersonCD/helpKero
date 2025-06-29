/* global pdfjsLib,fabric,jQuery,toastr,fetch */
const pdfCanvas   = document.getElementById('pdf-canvas');
const drawCanvas  = document.getElementById('draw-canvas');
const pdfCtx      = pdfCanvas.getContext('2d');
// Enable selection for multi-select
const fabricCanvas = new fabric.Canvas(drawCanvas, { selection: true, backgroundColor: 'transparent' });

let pdfDoc=null, pageNum=1, scale=1.2;

function renderPage(num){
  pdfDoc.getPage(num).then(page=>{
      const viewport = page.getViewport({scale});
      [pdfCanvas, drawCanvas].forEach(c=>{
          c.width  = viewport.width;
          c.height = viewport.height;
      });
      fabricCanvas.setWidth(viewport.width);
      fabricCanvas.setHeight(viewport.height);
      page.render({ canvasContext: pdfCtx, viewport });
      document.getElementById('page-num').textContent = num;
  });
}
// Navigation
function prevPage(){ if(pageNum<=1) return; pageNum--; renderPage(pageNum); syncBoxesToPage();}
function nextPage(){ if(pageNum>=pdfDoc.numPages) return; pageNum++; renderPage(pageNum); syncBoxesToPage();}
window.prevPage = prevPage;
window.nextPage = nextPage;

// Upload & load pdf
document.getElementById('pdf-file').addEventListener('change',e=>{
    const file = e.target.files[0];
    if(!file) return;
    const reader = new FileReader();
    reader.onload = function(){
        const typedarray = new Uint8Array(this.result);
        pdfjsLib.getDocument(typedarray).promise.then(pdf=>{
            pdfDoc = pdf; pageNum = 1;
            document.getElementById('page-count').textContent = pdf.numPages;
            fabricCanvas.clear();
            renderPage(pageNum);
        });
    };
    reader.readAsArrayBuffer(file);
});

/* Drawing */
let isDrawing=false, startX, startY;
fabricCanvas.on('mouse:down', function(o) {
    if (pdfDoc === null) return;
    // Multi-select logic
    if (o.target && isCtrlDown) {
        // Toggle selection for Ctrl+Click
        if (fabricCanvas.getActiveObjects().includes(o.target)) {
            fabricCanvas.discardActiveObject(o.target);
            o.target.set('active', false);
        } else {
            if (!fabricCanvas.getActiveObject() || !fabricCanvas.getActiveObject().type === 'activeSelection') {
                fabricCanvas.setActiveObject(o.target);
            } else {
                const sel = fabricCanvas.getActiveObject();
                if (sel.type === 'activeSelection') {
                    sel.addWithUpdate(o.target);
                }
            }
        }
        fabricCanvas.requestRenderAll();
        return;
    }
    // Only start drawing if not clicking on an object
    if (o.target) return; // Let Fabric handle selection/move
    isDrawing = true;
    const p = fabricCanvas.getPointer(o.e);
    startX = p.x; startY = p.y;
    const rect = new fabric.Rect({
        left: startX, top: startY, width: 0, height: 0,
        fill: 'rgba(0,0,255,0.15)', stroke: 'blue', strokeWidth: 1
    });
    fabricCanvas.add(rect); fabricCanvas.setActiveObject(rect);
});
fabricCanvas.on('mouse:move',o=>{
    if(!isDrawing) return;
    const p=fabricCanvas.getPointer(o.e);
    const rect=fabricCanvas.getActiveObject();
    rect.set({ width: p.x-startX, height: p.y-startY });
    rect.setCoords();
    fabricCanvas.renderAll();
});
fabricCanvas.on('mouse:up',o=>{ isDrawing=false; updateBoxList(); });
fabricCanvas.on('object:modified',updateBoxList);
fabricCanvas.on('object:removed',updateBoxList);

// Utilities
const boxesByPage = {};

/* 1. WRITE layout --------------------------------------------------- */
function updateBoxList(){
  const pdfH = drawCanvas.height / scale;          // real PDF height
  const objs = fabricCanvas.getObjects();

  boxesByPage[pageNum-1] = objs.map(o => ({
      page   : pageNum - 1,
      x0     :  o.left               / scale,
      x1     : (o.left + o.width)    / scale,
      top    :  o.top                / scale,
      bottom : (o.top + o.height)    / scale      // NOTE: top < bottom
  }));

  refreshListUI();
}

function refreshListUI(){
    const div = document.getElementById('box-list');
    div.innerHTML='';
    Object.values(boxesByPage).flat().forEach((b,i)=>{
        const d=document.createElement('div');
        d.textContent=`#${i+1} p${b.page} (${b.x0.toFixed(1)},${b.bottom.toFixed(1)})-(${b.x1.toFixed(1)},${b.top.toFixed(1)})`;
        div.appendChild(d);
    });
}

function syncBoxesToPage(){
  fabricCanvas.clear();
  const arr = boxesByPage[pageNum-1] || [];

  arr.forEach(b=>{
      const rect = new fabric.Rect({
          left  : b.x0 * scale,
          top   : b.top * scale,
          width : (b.x1 - b.x0) * scale,
          height: (b.bottom - b.top) * scale,
          fill  : 'rgba(0,0,255,0.15)',
          stroke: 'blue',
          strokeWidth: 1
      });
      fabricCanvas.add(rect);
  });
  fabricCanvas.renderAll();
  refreshListUI();
}

// Delete key
document.addEventListener('keydown',e=>{
    if(e.key==='Delete'){
        const obj=fabricCanvas.getActiveObject();
        if(obj){fabricCanvas.remove(obj);}
    }
});

// Save layout
function saveLayout(){
    const name=document.getElementById('layout-name').value.trim();
    const allBoxes = Object.values(boxesByPage).flat();
    if(!name){toastr.error('name required'); return;}
    if(allBoxes.length===0){toastr.error('add boxes'); return;}
    const payload = { template_name:name, created_at:new Date().toISOString(), boxes: allBoxes };
    fetch('/save_layout',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})
      .then(r=>r.json()).then(d=>{
        if(d.status==='ok'){ toastr.success('layout saved'); loadLayouts(); }
        else toastr.error('save failed');
    });
}
window.saveLayout = saveLayout;

// Mode toggle & extraction from previous version (unchanged)
function showAnnotate(){ document.getElementById('annotate-pane').classList.remove('hidden'); document.getElementById('extract-pane').classList.add('hidden'); }
function showExtract(){ document.getElementById('annotate-pane').classList.add('hidden'); document.getElementById('extract-pane').classList.remove('hidden'); loadLayouts(); }
window.showAnnotate = showAnnotate;
window.showExtract = showExtract;

function loadLayouts(){
    fetch('/list_layouts').then(r=>r.json()).then(arr=>{
        const sel=document.getElementById('layout-select'); sel.innerHTML='';
        arr.forEach(f=>{ const opt=document.createElement('option'); opt.value=f; opt.textContent=f; sel.appendChild(opt); });
    });
}
function runExtract(){
    const layout=document.getElementById('layout-select').value;
    const files=document.getElementById('pdf-batch').files;
    if(!layout||files.length===0){toastr.error('need layout + files');return;}
    const form=new FormData(); form.append('layout',layout); Array.from(files).forEach(f=>form.append('files',f));
    fetch('/extract',{method:'POST',body:form})
      .then(async r=>{
        let data;
        try {
          data = await r.json();
        } catch (e) {
          const text = await r.text();
          toastr.error('Server error: ' + text);
          throw e;
        }
        return data;
      })
      .then(d=>{
        if(d.status==='ok'){ 
          const link=document.createElement('a'); 
          link.href='/download/'+d.txt; // changed from d.csv to d.txt
          link.textContent='Download TXT'; 
          document.getElementById('download-link').innerHTML=''; 
          document.getElementById('download-link').appendChild(link); 
        }
        else toastr.error('extract error');
      });
}
window.runExtract = runExtract;

// Duplicate selected box(es)
function duplicateBox() {
    const objs = fabricCanvas.getActiveObjects();
    if (!objs || objs.length === 0) { toastr.error('Select box(es) to duplicate'); return; }
    // Clone all selected objects and offset them
    objs.forEach(obj => {
        obj.clone(function(clone) {
            clone.set({
                left: obj.left + 20,
                top: obj.top + 20
            });
            fabricCanvas.add(clone);
        });
    });
    fabricCanvas.discardActiveObject();
    fabricCanvas.renderAll();
    updateBoxList();
}
window.duplicateBox = duplicateBox;
