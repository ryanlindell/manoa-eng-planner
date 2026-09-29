"""Central configuration. Change catalog year/term here, not in scattered literals.

To scrape a different catalog year: change CATOID below to one of the keys in
CATALOGS (add a new entry if the year you want isn't listed yet -- open
https://catalog.manoa.hawaii.edu/index.php?catoid=<guess>, the <select
name="catalog"> dropdown lists every catoid with its year, and "Course
Descriptions" in the left nav gives that catalog's navoid). Everything else
(pages/, data/, cache keys) automatically keys off CATOID so a second
catalog's capture never overwrites the first -- see MANUAL_PAGES_DIR and
DATA_DIR below.
"""

# catoid -> (navoid of "Course Descriptions", label). Confirmed by hand against
# the site's own catalog-picker dropdown; add a row here for any other year.
CATALOGS = {
    4: (949, "2026-2027 (current)"),
    2: (420, "2025-2026 (archived)"),
}

CATOID = 4
NAVOID = CATALOGS[CATOID][0]

BASE_URL = "https://catalog.manoa.hawaii.edu/content.php"

USER_AGENT = "manoa-course-planner/0.1 (personal academic planning tool, non-commercial)"

CACHE_DIR = "cache"
DEBUG_DIR = "debug"
# Kept unsuffixed for catoid 4 (the catalog everything currently checked into
# data/ was built from) so existing paths/URLs don't change; any other catoid
# gets its own data_catoid<N>/ so a second catalog's build can't clobber it.
DATA_DIR = "data" if CATOID == 4 else f"data_catoid{CATOID}"

# Manually-saved listing pages (content.php is WAF-gated for scripted requests;
# a human solves the challenge in a real browser and saves the rendered page here).
# Filenames: "<PREFIX>.html" for page 1, "<PREFIX>_2.html", "<PREFIX>_3.html" for
# any further pages within that subject. Namespaced by catoid (see DATA_DIR) so
# switching CATOID to re-scrape a different year starts from an empty folder
# instead of silently reusing the other catalog's saved pages.
MANUAL_PAGES_DIR = "pages" if CATOID == 4 else f"pages_catoid{CATOID}"

# NOTE: robots.txt for catalog.manoa.hawaii.edu declares crawl-delay: 120 for
# User-agent: * (we are not one of the two named bots that get 15s), which is
# far stricter than the 1s originally planned. Left at 1 for now pending a
# decision -- see chat for the flagged conflict. Bump to 120 before any bulk run
# unless told otherwise.
RATE_LIMIT_SECONDS = 1

# /ajax/ is explicitly Disallow'd for all user-agents in robots.txt.
# Do NOT use ajax/preview_course.php as a fallback data source; expanded
# content.php listings only.
