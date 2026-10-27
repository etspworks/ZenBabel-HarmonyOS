# Runs the exported graphs the way the app's native engine does (greedy, one slot of the self-attention cache
# per step) and checks that every output equals Hugging Face's own greedy generate(). Also checks that plain
# SentencePiece, which the app uses, splits each text into the same pieces as Hugging Face's tokenizer.
import sys

import numpy as np
import onnxruntime as ort
import sentencepiece
import torch
from transformers import AutoTokenizer, M2M100ForConditionalGeneration

MODEL = 'facebook/nllb-200-distilled-600M'
L = 256
S = 128
d = sys.argv[1]

CASES = [line.rstrip('\n').split('\t') for line in open(sys.argv[2] if len(sys.argv) > 2 else 'cases.tsv', encoding='utf-8')]

tok = AutoTokenizer.from_pretrained(MODEL)
sp = sentencepiece.SentencePieceProcessor(model_file=f'{d}/sentencepiece.bpe.model')
model = M2M100ForConditionalGeneration.from_pretrained(MODEL).eval()
enc = ort.InferenceSession(f'{d}/encoder.onnx')
dec = ort.InferenceSession(f'{d}/decoder.onnx')
vocab = open(f'{d}/vocab.txt', encoding='utf-8').read().split('\n')
piece_id = {p: i for i, p in enumerate(vocab)}


def translate(ids, tgt):
    pad = S - len(ids)
    cross = enc.run(None, {'input_ids': np.array([ids + [1] * pad], dtype=np.int32),
                           'attention_mask': np.array([[1] * len(ids) + [0] * pad], dtype=np.int32)})[0]
    cross_mask = np.array([[[[0.0] * len(ids) + [-1e4] * pad]]], dtype=np.float32)
    self_kv = np.zeros((cross.shape[0], 1, cross.shape[2], L, cross.shape[4]), dtype=np.float32)
    mask = np.full((1, 1, 1, L + 1), -1e4, dtype=np.float32)
    mask[..., L] = 0
    out, token = [], 2
    for step in range(min(L, 2 * len(ids) + 10)):
        nxt, new_kv = dec.run(None, {'token': np.array([[token]], dtype=np.int32), 'step': np.array([step], dtype=np.int32),
                                     'self_kv': self_kv, 'self_mask': mask, 'cross_kv': cross,
                                     'cross_mask': cross_mask})
        self_kv[:, :, :, step, :] = new_kv[:, :, :, 0, :]
        mask[..., step] = 0
        token = piece_id[tgt] if step == 0 else int(nxt[0])
        if token == 2:
            break
        out.append(token)
    return out


failed = 0
for src, tgt, text in CASES:
    tok.src_lang = src
    ids = tok(text).input_ids
    pieces = tok.convert_ids_to_tokens(ids)
    if pieces[1:-1] != sp.encode(text, out_type=str):
        failed += 1
        print('PIECES DIFF', src, text)
    ours = translate([piece_id.get(p, 3) for p in pieces], tgt)
    with torch.no_grad():
        ref = model.generate(torch.tensor([ids]), forced_bos_token_id=tok.convert_tokens_to_ids(tgt), num_beams=1, do_sample=False,
                             max_new_tokens=2 * len(ids) + 10)[0].tolist()
    ref = [t for t in ref[1:] if t != 2]
    ok = ours == ref
    failed += not ok
    print('OK ' if ok else 'DIFF', src, tgt, tok.decode(ours, skip_special_tokens=True))
    if not ok:
        print('     hf:', tok.decode(ref, skip_special_tokens=True))
print(f'{len(CASES) - failed}/{len(CASES)} identical')
sys.exit(1 if failed else 0)
