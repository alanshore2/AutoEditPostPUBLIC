#!/usr/bin/env python3
"""Dense face tracking for AutoEditPost's dynamic crop.

Samples the video every INTERVAL seconds, detects the largest face per frame
with OpenCV's Haar cascade, and prints a JSON array of
{"t": sec, "top": f, "chin": f, "left": f, "right": f} (fractions of frame).

The Haar box covers roughly eyebrows-to-chin, so we extend upward to include
the scalp (bald or not) and slightly downward to the true chin line.
"""
import json
import sys

import cv2

HEAD_UP_MAX = 0.9  # search ceiling above the box for the real head top (scalp)
CHIN_DOWN = 0.10   # extend box bottom downward (jawline undershoot)


def head_top_px(frame_ycrcb, x, y, fw, fh, height):
    """Walk upward from the face box, tracking where skin (the scalp) ends.

    The Haar box top lands anywhere between eyebrows and scalp depending on
    the frame, so a fixed extension over/undershoots. Skin segmentation in
    YCrCb is stable outdoors and a bald or hairlined scalp reads as skin.
    """
    cx0 = int(x + fw * 0.30)
    cx1 = int(x + fw * 0.70)
    top = y
    limit = max(0, int(y - HEAD_UP_MAX * fh))
    for row in range(y, limit, -1):
        strip = frame_ycrcb[row, cx0:cx1]
        cr = strip[:, 1]
        cb = strip[:, 2]
        skin = ((cr >= 133) & (cr <= 180) & (cb >= 77) & (cb <= 135)).mean()
        if skin < 0.30:
            break
        top = row
    return top


def main() -> None:
    if len(sys.argv) < 2:
        print("usage: face_track.py <video> [interval_sec]", file=sys.stderr)
        sys.exit(2)
    path = sys.argv[1]
    interval = float(sys.argv[2]) if len(sys.argv) > 2 else 0.25

    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        print(f"cannot open {path}", file=sys.stderr)
        sys.exit(1)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    w = cap.get(cv2.CAP_PROP_FRAME_WIDTH)
    h = cap.get(cv2.CAP_PROP_FRAME_HEIGHT)
    step = max(1, round(fps * interval))

    cascade = cv2.CascadeClassifier(
        cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
    )

    out = []
    for fi in range(0, total, step):
        cap.set(cv2.CAP_PROP_POS_FRAMES, fi)
        ok, frame = cap.read()
        if not ok:
            break
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        gray = cv2.equalizeHist(gray)
        faces = cascade.detectMultiScale(
            gray, scaleFactor=1.1, minNeighbors=5,
            minSize=(int(w * 0.15), int(w * 0.15)),
        )
        if len(faces) == 0:
            continue
        # largest face
        x, y, fw, fh = max(faces, key=lambda f: f[2] * f[3])
        ycrcb = cv2.cvtColor(frame, cv2.COLOR_BGR2YCrCb)
        top_px = head_top_px(ycrcb, x, y, fw, fh, h)
        top = max(0.0, (top_px - 0.03 * fh) / h)  # small hair/blur allowance
        chin = min(1.0, (y + fh + CHIN_DOWN * fh) / h)
        left = max(0.0, x / w)
        right = min(1.0, (x + fw) / w)
        out.append(
            {
                "t": round(fi / fps, 3),
                "top": round(top, 4),
                "chin": round(chin, 4),
                "left": round(left, 4),
                "right": round(right, 4),
            }
        )
    cap.release()
    json.dump(out, sys.stdout)


if __name__ == "__main__":
    main()
