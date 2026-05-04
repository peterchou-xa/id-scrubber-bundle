# -*- mode: python ; coding: utf-8 -*-
from PyInstaller.utils.hooks import collect_all, copy_metadata

datas = []
binaries = []
hiddenimports = ['paddleocr_scrub']

# PaddleOCR + PaddleX ship pipeline YAML configs and model metadata as
# package data files. Without collect_all() PyInstaller drops them and the
# pipeline init raises "The pipeline (OCR) does not exist!" at runtime.
for pkg in (
    'paddleocr',
    'paddlex',
    'paddle',
    'gliner',
    'transformers',
    'tokenizers',
    'sentencepiece',
    'huggingface_hub',
    'onnxruntime',
    'pypdfium2',
    'pikepdf',
    'pdfminer',
    'pymupdf',
):
    tmp_d, tmp_b, tmp_h = collect_all(pkg)
    datas += tmp_d
    binaries += tmp_b
    hiddenimports += tmp_h

# PaddleX runtime-checks its dependencies via importlib.metadata.version(),
# which reads the *.dist-info/METADATA file. PyInstaller doesn't auto-bundle
# this metadata. Without it, paddlex raises DependencyError at OCR pipeline
# init even though the packages themselves are present in the bundle.
# This list mirrors paddlex[ocr]'s extras_require.
for pkg in (
    'paddlex',
    'paddleocr',
    'paddlepaddle',
    'Jinja2',
    'beautifulsoup4',
    'einops',
    'ftfy',
    'imagesize',
    'latex2mathml',
    'lxml',
    'opencv-contrib-python',
    'openpyxl',
    'premailer',
    'pyclipper',
    'pypdfium2',
    'python-bidi',
    'regex',
    'safetensors',
    'scikit-learn',
    'scipy',
    'sentencepiece',
    'shapely',
    'tiktoken',
    'tokenizers',
    'onnxruntime',
    'gliner',
    'transformers',
):
    try:
        datas += copy_metadata(pkg)
    except Exception:
        # Some packages (paddlepaddle especially) may not be importable yet
        # at spec-eval time on every machine; skip rather than fail the build.
        pass


a = Analysis(
    ['main.py'],
    pathex=['.'],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=['ollama', 'rapidocr', 'pytesseract'],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='identity-scrubber',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name='identity-scrubber',
)
