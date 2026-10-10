"""Derive Qanary's nothing-up-my-sleeve canary key.

The canary key is an Ed25519 public key whose private key nobody knows:
  1. h = SHA-256(PHRASE || counter) for counter = 0, 1, 2, ...
  2. the first h that decodes as a compressed Edwards25519 point P is used
  3. canary = 8 * P (clears the cofactor, so the point lies in the prime-order subgroup)

Anyone can rerun this script (standard library only) and get the same key.
programs/qanary_bounty/tests/test_canary_key.rs checks the result again with curve25519-dalek.
"""
import hashlib

PHRASE = b"Qanary canary v1: nobody knows the private key of this point"

P = 2**255 - 19
D = (-121665 * pow(121666, P - 2, P)) % P
SQRT_M1 = pow(2, (P - 1) // 4, P)


def decompress(b: bytes):
    y = int.from_bytes(b, "little") & ((1 << 255) - 1)
    sign = b[31] >> 7
    if y >= P:
        return None
    u = (y * y - 1) % P
    v = (D * y * y + 1) % P
    x2 = u * pow(v, P - 2, P) % P
    x = pow(x2, (P + 3) // 8, P)
    if (x * x - x2) % P != 0:
        x = x * SQRT_M1 % P
    if (x * x - x2) % P != 0:
        return None
    if x == 0 and sign == 1:
        return None
    if (x & 1) != sign:
        x = P - x
    return (x, y)


def add(p1, p2):
    (x1, y1), (x2, y2) = p1, p2
    t = D * x1 * x2 * y1 * y2 % P
    x3 = (x1 * y2 + x2 * y1) * pow(1 + t, P - 2, P) % P
    y3 = (y1 * y2 + x1 * x2) * pow(1 - t, P - 2, P) % P
    return (x3, y3)


def compress(pt) -> bytes:
    x, y = pt
    return (y | ((x & 1) << 255)).to_bytes(32, "little")


B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def base58(b: bytes) -> str:
    n = int.from_bytes(b, "big")
    out = ""
    while n:
        n, r = divmod(n, 58)
        out = B58[r] + out
    return "1" * (len(b) - len(b.lstrip(b"\0"))) + out


def main():
    for counter in range(256):
        h = hashlib.sha256(PHRASE + bytes([counter])).digest()
        point = decompress(h)
        if point is None:
            continue
        q = point
        for _ in range(3):  # 8 * P via three doublings
            q = add(q, q)
        assert q != (0, 1), "small-order point"
        key = compress(q)
        print(f"counter = {counter}")
        print(f"hash    = {h.hex()}")
        print(f"canary  = {base58(key)}")
        print(f"bytes   = {list(key)}")
        return
    raise SystemExit("no valid point found")


if __name__ == "__main__":
    main()
