# gf-ready

Ready-video runner. When the backend watcher sees new news it starts the **ready videos** workflow: GitHub Actions
opens the live site in Chrome and makes the 5 and 10 minute videos (news from the last 3 / 6 / 12 hours) with the
site's own code, split over several tabs, then publishes each one **encrypted** (AES-256-GCM) on branch
`s-<length>_<window>`. Each branch holds exactly one video (force-replaced, no history). Nothing here is watchable
without a valid key.
