#!/usr/bin/env python3
# ─── Lily greeter — team face recognition (local, offline) ────────────────────
#
# A long-running helper that faces.js talks to over stdin/stdout, one JSON
# object per line. OpenCV only: YuNet finds faces, SFace turns each face into
# a 128-number fingerprint, and a fingerprint close enough to one from a team
# member's photos is that person. Nothing leaves this computer.
#
# Team photos: greeter/team/<Name>/*.jpg (the setup page saves them there).
# Models:      greeter/models/ (setup-linux.sh downloads them).
#
# Requests  {"id": 1, "cmd": "identify", "jpeg": "<base64>", "minFace": 60, "threshold": 0.4}
#           {"id": 2, "cmd": "check",    "jpeg": "<base64>"}   -> faces found in a photo
#           {"id": 3, "cmd": "reload"}                          -> re-read team photos
# Replies   {"id": 1, "ok": true, ...}  or  {"id": 1, "ok": false, "error": "..."}

import base64
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
MODELS = os.path.join(HERE, 'models')
TEAM_DIR = os.path.join(HERE, 'team')
DET_MODEL = os.path.join(MODELS, 'face_detection_yunet_2023mar.onnx')
REC_MODEL = os.path.join(MODELS, 'face_recognition_sface_2021dec.onnx')
PHOTO_EXT = ('.jpg', '.jpeg', '.png')


def say(obj):
    sys.stdout.write(json.dumps(obj) + '\n')
    sys.stdout.flush()


try:
    import cv2
    import numpy as np
    for m in (DET_MODEL, REC_MODEL):
        if not os.path.exists(m):
            raise RuntimeError(f'model missing: {os.path.basename(m)} (run setup-linux.sh)')
    detector = cv2.FaceDetectorYN.create(DET_MODEL, '', (320, 320), 0.8, 0.3, 50)
    recognizer = cv2.FaceRecognizerSF.create(REC_MODEL, '')
except Exception as e:  # report and stay alive so the server can show why
    say({'ready': False, 'error': str(e)})
    for _ in sys.stdin:
        pass
    sys.exit(0)


def decode(b64):
    img = cv2.imdecode(np.frombuffer(base64.b64decode(b64), np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError('not an image')
    return img


def detect(img):
    h, w = img.shape[:2]
    # Big phone photos: shrink first, YuNet is fast on ~640 px and accurate enough.
    scale = min(1.0, 960 / max(h, w))
    if scale < 1.0:
        img = cv2.resize(img, (int(w * scale), int(h * scale)))
        h, w = img.shape[:2]
    detector.setInputSize((w, h))
    _, faces = detector.detect(img)
    return img, ([] if faces is None else list(faces))


def fingerprint(img, face):
    f = recognizer.feature(recognizer.alignCrop(img, face)).flatten()
    return f / (np.linalg.norm(f) or 1.0)


team = {}      # name -> [fingerprints]
team_info = {}  # name -> {photos, usable}


def load_team():
    team.clear()
    team_info.clear()
    if not os.path.isdir(TEAM_DIR):
        return
    for name in sorted(os.listdir(TEAM_DIR)):
        folder = os.path.join(TEAM_DIR, name)
        if not os.path.isdir(folder):
            continue
        prints, photos = [], 0
        for fn in sorted(os.listdir(folder)):
            if not fn.lower().endswith(PHOTO_EXT):
                continue
            photos += 1
            img = cv2.imread(os.path.join(folder, fn))
            if img is None:
                continue
            img, faces = detect(img)
            if not faces:
                continue
            biggest = max(faces, key=lambda f: f[2] * f[3])  # the person in the photo, not a face behind them
            prints.append(fingerprint(img, biggest))
        team_info[name] = {'photos': photos, 'usable': len(prints)}
        if prints:
            team[name] = prints


def identify(req):
    img, faces = detect(decode(req['jpeg']))
    min_face = req.get('minFace', 60)
    threshold = req.get('threshold', 0.4)
    out = []
    for f in faces:
        if f[2] < min_face:  # too small = across the room, not at the door
            continue
        fp = fingerprint(img, f)
        best_name, best = None, -1.0
        for name, prints in team.items():
            score = max(float(np.dot(fp, p)) for p in prints)
            if score > best:
                best_name, best = name, score
        out.append({'name': best_name if best >= threshold else None,
                    'closest': best_name, 'score': round(best, 3), 'size': int(f[2])})
    return {'faces': out}


load_team()
say({'ready': True, 'team': team_info, 'opencv': cv2.__version__})

for line in sys.stdin:
    try:
        req = json.loads(line)
    except ValueError:
        continue
    rid = req.get('id')
    try:
        cmd = req.get('cmd')
        if cmd == 'identify':
            say({'id': rid, 'ok': True, **identify(req)})
        elif cmd == 'check':
            _, faces = detect(decode(req['jpeg']))
            say({'id': rid, 'ok': True, 'faces': len(faces)})
        elif cmd == 'reload':
            load_team()
            say({'id': rid, 'ok': True, 'team': team_info})
        else:
            say({'id': rid, 'ok': False, 'error': f'unknown cmd {cmd}'})
    except Exception as e:
        say({'id': rid, 'ok': False, 'error': str(e)})
