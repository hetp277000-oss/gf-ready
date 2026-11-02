# gf-ready

Render runner for Global Flash ready videos. Every few hours GitHub Actions opens the Global Flash site in Chrome, makes the
news video for each length (2/5/10 min) and news window (3/6/12/24 h), and publishes it here **encrypted** (AES-256-GCM)
on branch `s-<length>_<window>`. Nothing in this repo is watchable without a valid Global Flash key.
