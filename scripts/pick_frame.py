#!/usr/bin/env python3
"""Pick the most inviting cover frame from a talking-head video.

Samples frames, detects the largest face, then scores each frame:
smile detected (+2), both eyes detected (+1). Ties go to the frame closest
to the middle of the video. Prints the best timestamp in seconds.
"""
import sys

import cv2

def main() -> None:
    path = sys.argv[1]
    interval = float(sys.argv[2]) if len(sys.argv) > 2 else 0.4

    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        print("cannot open " + path, file=sys.stderr)
        sys.exit(1)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    dur = total / fps
    step = max(1, round(fps * interval))

    cdir = cv2.data.haarcascades
    face_c = cv2.CascadeClassifier(cdir + "haarcascade_frontalface_default.xml")
    eye_c = cv2.CascadeClassifier(cdir + "haarcascade_eye.xml")
    smile_c = cv2.CascadeClassifier(cdir + "haarcascade_smile.xml")

    best_t, best_score = dur * 0.25, -1.0
    for fi in range(0, total, step):
        cap.set(cv2.CAP_PROP_POS_FRAMES, fi)
        ok, frame = cap.read()
        if not ok:
            break
        gray = cv2.equalizeHist(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY))
        faces = face_c.detectMultiScale(gray, 1.1, 5, minSize=(80, 80))
        if len(faces) == 0:
            continue
        x, y, w, h = max(faces, key=lambda f: f[2] * f[3])
        roi = gray[y : y + h, x : x + w]
        upper = roi[: int(h * 0.6)]
        lower = roi[int(h * 0.5) :]
        eyes = eye_c.detectMultiScale(upper, 1.1, 6)
        # High minNeighbors: the smile cascade loves false positives.
        smiles = smile_c.detectMultiScale(lower, 1.6, 22)
        t = fi / fps
        # eyes-required mode (3rd arg "eyes"): never pick a blink for a cover
        if len(sys.argv) > 3 and sys.argv[3] == "eyes" and len(eyes) < 2:
            continue
        score = (1.0 if len(smiles) > 0 else 0.0) + (2.0 if len(eyes) >= 2 else 0.0)
        # tie-break: prefer mid-video, speaker is settled there
        score -= abs(t - dur / 2) / dur * 0.5
        if score > best_score:
            best_score, best_t = score, t
    cap.release()
    print(f"{best_t:.2f}")


if __name__ == "__main__":
    main()
