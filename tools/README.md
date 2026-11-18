# tools

学習・検証・観戦用のスクリプトです。Node 22 以上で動き、追加のパッケージは要りません。リポジトリのルートで実行します。

| スクリプト | 用途 |
|---|---|
| `test_engine.js` | エンジンの正しさの検証 |
| `match.js` | 2つの設定を対戦させて勝率・Elo差を測る |
| `selfplay.js` | 学習用の自己対戦データを作る |
| `train.js` | 自己対戦データから点数表を学習する |
| `build_book.js` | 定石ブックを作る |
| `build_openings.js` | 定石名データを作る |
| `build_lessons.js` | 講座の練習問題を作る |
| `watch_server.js` | othello.org のCOMと対局し、ブラウザで観戦・記録・再生する |
| `vs_othello_org.js` | 同じ対局を画面なしで行う |
| `dump_vectors.js` | Python 版の突き合わせテスト用データを出力する |
| `cdp_shot.js` | ヘッドレス Chrome でページを開いて確認する |
| `common.js` | 共通の補助関数（乱数、重み・定石の読み込み、引数） |
| `legacy/index_v1.html` | 以前の版。`match.js` の比較相手として使う |

## 検証

```
node tools/test_engine.js          # perft 1〜9、合法手、完全読み対総当たり、対称性
node tools/test_engine.js --ffo    # 加えて FFO#40（残り20手、正解 +38）を解く
```

## 対戦測定 `match.js`

```
node tools/match.js --a '{"level":10}' --b '{"level":9}' --pairs 12 --plies 6 --seed 1
node tools/match.js --a '{"level":8}'  --b '{"legacy":8}' --pairs 15
node tools/match.js --a '{"opts":{"depth":6,"exact":12},"weights":"data/w_new.js"}' --b '{"opts":{"depth":6,"exact":12}}' --pairs 100
```

- `--pairs N`: ランダムな序盤を N 個作り、それぞれ先後を入れ替えて2局（計 2N 局）。
- `--plies`: 序盤のランダム手数（既定 6）。
- プレイヤー指定は JSON。`{"level":n}` は製品のレベル n、`{"opts":{…}}` は `think()` の生オプション（`weights` で重みファイル、`"weights":false` で手書き評価、`"book":true` で定石）、`{"legacy":n}` は以前の版の強さ n。
- 出力は A から見た勝敗・勝率・Elo差・平均石差。

## 学習の流れ

```
# 1. 自己対戦（1プロセス1ファイル。並列にしたいときは seed と out を変えて複数起動）
node tools/selfplay.js --games 20000 --depth 4 --exact 12 --seed 1 --out data/g3_1.bin
#    --noweights を付けると手書き評価で打つ（最初の世代用）

# 2. 学習（prefix に合うファイルを全部読む）
node --max-old-space-size=16000 tools/train.js --data data --prefix g0_,g1_,g2_ --iters 250 --out data/w_new.js

# 3. 今の重みと対戦させて強くなったか確かめ、良ければ js/weights.js に置き換える
node tools/match.js --a '{"opts":{"depth":6,"exact":12},"weights":"data/w_new.js"}' --b '{"opts":{"depth":6,"exact":12}}' --pairs 100
```

- 自己対戦の1レコードは int32×5（手番側の石、相手の石を各2語、手番側から見た最終石差）。序盤2〜16手はランダム、残り `--exact` 手からは完全読みです。
- `train.js` は石数6個ごとの10段階それぞれで、前後の段階のデータも合わせて学習します。20局面に1つを検証用に取り分け、検証誤差が8回続けて改善しなければ打ち切ります。
- 現在の `js/weights.js` は g0（手書き評価・深さ4・12万局）、g1（深さ6・6万局）、g2（深さ4・20万局）の全部で学習したものです。`data/` は容量が大きいためリポジトリには含めていません。

## 定石ブック `build_book.js`

```
node tools/build_book.js --budget 6 --plies 16 --dexp 8 --dleaf 10 --workers 11 --max 14000
```

初手から、双方の「最善との差」の合計が `--budget` 石以内に収まる手順を `--plies` 手までたどり（各手は深さ `--dexp` で採点）、末端を深さ `--dleaf` で読んで値を根元へ伝えます。現在のブックはこの設定で作った14,000局面です。

## 定石名 `build_openings.js`

スクリプト内の定石一覧（名前と手順）を1つずつ盤上で再生して合法性を確かめ、対称形をまとめたキーで `js/openings.js` に書き出します。

## 練習問題 `build_lessons.js`

```
node tools/build_lessons.js --per 4 --minutes 6
```

AI同士（少し乱数を入れた3手読み）の対局から、各テーマの条件に合う局面を探します。条件は「最善手がそのテーマの特徴を持ち、次善手に一定以上の差をつけている」ことです。全部の合法手を採点して（残り12手以下は完全読み、それ以外は6手読み）`js/lesson_data.js` に書き出します。`--minutes` で打ち切り時間を指定します。「手を稼ぐ（パスさせる）」は条件が厳しく、6分で1問しか見つかっていません。

## othello.org との対局 `watch_server.js`

```
node tools/watch_server.js --level 10 --com 2 --games 10 --port 8765
# ブラウザで http://localhost:8765 を開く
node tools/watch_server.js --games 0        # 新しい対局はせず、記録の閲覧だけ
```

- **しくみ**: othello.org の対局ページは、COMの手番になるたびに同サイトの `ajax/nextmove.cgi` へ盤面64文字（0=空、1=黒、2=白）・手番・レベルを送り、返ってきた1手を置いています。このスクリプトは同じ形式のリクエストを1手ごとに送り、こちらの手番は手元のエンジンが考えます。
- **負荷**: 対局は1局ずつ順番で、COMの手の前に1.2秒待ちます。人が1人で遊ぶのと同じ量です。相手のサーバーなので、大量に回すのは控えてください。
- **画面**: 盤面、こちらの直前の手（選び方・評価・読んだ局面数・手の特徴）、棋譜、勝敗表が1手ごとに更新されます。途中から開いても現在の局面から見られます。
- **記録と再生**: 終わった対局は `records/vs_othello_org.jsonl` に1行ずつ追記されます。画面の「再生」を押すと、本体アプリの棋譜再生（`/app/index.html?kifu=…`）で開きます。
- `--com` は 0=初級、1=中級、2=上級。`--level` はこちらのレベル（1〜10）。

`vs_othello_org.js` は同じ対局を画面なしで行い、結果と棋譜を標準出力に出すだけです（記録ファイルには書きません）。

```
node tools/vs_othello_org.js --level 10 --com 2 --games 2
```

## ページの確認 `cdp_shot.js`

```
node tools/cdp_shot.js <URL> <出力.png> <待ち時間ms> [幅] [高さ] [評価するJS式]
node tools/cdp_shot.js "file:///…/index.html?demo=8" shot.png 12000 390 844 "document.title"
```

ヘッドレス Chrome を DevTools プロトコルで操作し、ページを開いて指定時間待ち、JS式の値・例外やコンソールエラーの有無を表示して、スクリーンショットを保存します。Chrome の場所は環境変数 `CHROME` で変えられます。本体の `?demo=レベル` は自動対局、`?kifu=棋譜` は棋譜の読み込みです。

## Python 版との突き合わせ `dump_vectors.js`

```
node tools/dump_vectors.js ../../python/othello_game/data/test_vectors.json
```

ランダムな対局の3,600局面について、合法手・評価値・正規化キー・深さ3の探索値・残り10手以下の完全読みの値・定石の手を出力します。Python 版の `test_engine.py` がこれと一致することを確かめます。
