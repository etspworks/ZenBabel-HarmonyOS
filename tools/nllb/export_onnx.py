# Exports facebook/nllb-200-distilled-600M (an M2M100-architecture model) as two ONNX graphs for MindSpore Lite,
# plus the token table, the language token list and the SentencePiece model.
#
# encoder.onnx  input_ids [1,S] int32, attention_mask [1,S] int32 (1 = token, 0 = padding)
#                 -> cross_kv [2*layers,1,heads,S,head_dim]
#                 (the cross-attention keys/values of every decoder layer, computed once per sentence)
# decoder.onnx  token [1,1] int32, step [1] int32, self_kv [2*layers,1,heads,L,head_dim],
#               self_mask [1,1,1,L+1] float (0 = attend, -1e4 = skip), cross_kv, cross_mask [1,1,1,S] float
#                 -> next_token [1] int32, new_kv [2*layers,1,heads,1,head_dim]
#
# Every shape is fixed: the source is padded to S tokens, and the self-attention cache is a buffer of L slots that
# the caller fills one slot per step. MindSpore Lite's FP16 CPU runtime breaks when a model is resized, so the app
# never resizes. Masks use -1e4, not float32's minimum as Hugging Face does, which overflows in FP16; both layer
# stacks are written out here for that reason (the decoder also for its fixed-size cache).
import os
import shutil
import sys

import torch
from huggingface_hub import hf_hub_download
from transformers import AutoTokenizer, M2M100ForConditionalGeneration

MODEL = 'facebook/nllb-200-distilled-600M'
L = 256
S = 128
out = sys.argv[1]
os.makedirs(out, exist_ok=True)

model = M2M100ForConditionalGeneration.from_pretrained(MODEL).eval().requires_grad_(False)
tok = AutoTokenizer.from_pretrained(MODEL)
dec = model.model.decoder

# NLLB's residual stream reaches about 2e4, and LayerNorm squares it: past FP16's 65504, so MindSpore Lite's FP16
# kernels produce garbage. LayerNorm ignores a constant factor, so the stream is carried divided by RESIDUAL_SCALE:
# the embeddings and every sublayer's output projection are scaled down, and the next LayerNorm undoes it.
RESIDUAL_SCALE = 128
with torch.no_grad():
    for stack in (model.model.encoder, dec):
        stack.embed_tokens.embed_scale = stack.embed_tokens.embed_scale / RESIDUAL_SCALE
        stack.embed_positions.weights.div_(RESIDUAL_SCALE)
        for layer in stack.layers:
            outputs = [layer.self_attn.out_proj, layer.fc2] + ([layer.encoder_attn.out_proj] if stack is dec else [])
            for linear in outputs:
                linear.weight.div_(RESIDUAL_SCALE)
                linear.bias.div_(RESIDUAL_SCALE)
cfg = model.config
H = cfg.decoder_attention_heads
D = cfg.d_model // H
E = cfg.d_model


def heads(x):
    return x.view(1, -1, H, D).transpose(1, 2)


def attend(a, x, k, v, mask):
    q = heads(a.q_proj(x) * a.scaling)
    w = torch.softmax(q @ k.transpose(-1, -2) + mask, dim=-1)
    return a.out_proj((w @ v).transpose(1, 2).reshape(1, x.shape[1], E))


class Encoder(torch.nn.Module):
    def __init__(self):
        super().__init__()
        self.model = model  # owning the model makes its weights named initializers instead of constants

    def forward(self, input_ids, attention_mask):
        enc = model.model.encoder
        # Padding is at the end, so the real tokens sit at positions 0..n-1, as Hugging Face numbers them.
        pos = enc.embed_positions.weights.index_select(0, torch.arange(S) + enc.padding_idx + 1)
        h = enc.embed_tokens(input_ids.long()) + pos.view(1, S, E)
        mask = ((1 - attention_mask.float()) * -1e4).view(1, 1, 1, S)
        for layer in enc.layers:
            a = layer.self_attn
            x = layer.self_attn_layer_norm(h)
            h = h + attend(a, x, heads(a.k_proj(x)), heads(a.v_proj(x)), mask)
            x = layer.final_layer_norm(h)
            h = h + layer.fc2(layer.activation_fn(layer.fc1(x)))
        h = enc.layer_norm(h)
        kv = []
        for layer in dec.layers:
            kv += [heads(layer.encoder_attn.k_proj(h)), heads(layer.encoder_attn.v_proj(h))]
        return torch.stack(kv)


class Decoder(torch.nn.Module):
    def __init__(self):
        super().__init__()
        self.model = model
        # One [E, vocab] matrix serves both the token lookup (a column) and the output projection, so the
        # graph holds the tied embedding once instead of a second, transposed copy.
        self.vocab_matrix = torch.nn.Parameter(model.lm_head.weight.t().contiguous(), requires_grad=False)

    def forward(self, token, step, self_kv, self_mask, cross_kv, cross_mask):
        pos = dec.embed_positions.weights.index_select(0, step.long() + dec.padding_idx + 1)
        h = (self.vocab_matrix.index_select(1, token.view(1).long()) * dec.embed_tokens.embed_scale).view(1, 1, E) + pos.view(1, 1, E)
        new_kv = []
        for i, layer in enumerate(dec.layers):
            a = layer.self_attn
            x = layer.self_attn_layer_norm(h)
            k, v = heads(a.k_proj(x)), heads(a.v_proj(x))
            new_kv += [k, v]
            h = h + attend(a, x, torch.cat([self_kv[2 * i], k], 2), torch.cat([self_kv[2 * i + 1], v], 2), self_mask)
            x = layer.encoder_attn_layer_norm(h)
            h = h + attend(layer.encoder_attn, x, cross_kv[2 * i], cross_kv[2 * i + 1], cross_mask)
            x = layer.final_layer_norm(h)
            h = h + layer.fc2(layer.activation_fn(layer.fc1(x)))
        logits = dec.layer_norm(h).view(1, E) @ self.vocab_matrix
        return logits.argmax(-1).int(), torch.stack(new_kv)


with torch.no_grad():
    ids = tok('Hello world.').input_ids
    mask = torch.tensor([[1] * len(ids) + [0] * (S - len(ids))], dtype=torch.int32)
    ids = torch.tensor([ids + [tok.pad_token_id] * (S - len(ids))], dtype=torch.int32)
    cross = Encoder()(ids, mask)
    torch.onnx.export(Encoder(), (ids, mask), f'{out}/encoder.onnx', input_names=['input_ids', 'attention_mask'],
                      output_names=['cross_kv'], opset_version=14)
    args = (torch.tensor([[2]], dtype=torch.int32), torch.tensor([0], dtype=torch.int32),
            torch.zeros(2 * len(dec.layers), 1, H, L, D), torch.zeros(1, 1, 1, L + 1), cross, torch.zeros(1, 1, 1, S))
    torch.onnx.export(Decoder(), args, f'{out}/decoder.onnx',
                      input_names=['token', 'step', 'self_kv', 'self_mask', 'cross_kv', 'cross_mask'],
                      output_names=['next_token', 'new_kv'], opset_version=14)

with open(f'{out}/vocab.txt', 'w', encoding='utf-8') as f:
    for piece in tok.convert_ids_to_tokens(list(range(len(tok)))):
        f.write(piece + '\n')
# The language tokens (eng_Latn, jpn_Jpan, ...): what translate() accepts, and what decoding drops.
with open(f'{out}/languages.txt', 'w', encoding='utf-8') as f:
    for code in tok.additional_special_tokens:
        f.write(code + '\n')
shutil.copy(hf_hub_download(MODEL, 'sentencepiece.bpe.model'), f'{out}/sentencepiece.bpe.model')
print('layers', len(dec.layers), 'heads', H, 'head_dim', D, 'vocab', len(tok), 'languages', len(tok.additional_special_tokens))
