.PHONY: og

# Re-render public/og.png (share image) from the live /api/summary.
# make og BASE=http://localhost:8787 to use another deployment.
BASE ?= https://punctuality.lad.lviv.ua
og:
	uv run scripts/og.py $(BASE)
