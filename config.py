"""Central configuration. Change catalog year/term here, not in scattered literals."""

CATOID = 4
NAVOID = 949

BASE_URL = "https://catalog.manoa.hawaii.edu/content.php"

USER_AGENT = "manoa-course-planner/0.1 (personal academic planning tool, non-commercial)"

CACHE_DIR = "cache"
DEBUG_DIR = "debug"
DATA_DIR = "data"

# Manually-saved listing pages (content.php is WAF-gated for scripted requests;
# a human solves the challenge in a real browser and saves the rendered page here).
# Filenames: "<PREFIX>.html" for page 1, "<PREFIX>_2.html", "<PREFIX>_3.html" for
# any further pages within that subject.
MANUAL_PAGES_DIR = "pages"

# NOTE: robots.txt for catalog.manoa.hawaii.edu declares crawl-delay: 120 for
# User-agent: * (we are not one of the two named bots that get 15s), which is
# far stricter than the 1s originally planned. Left at 1 for now pending a
# decision -- see chat for the flagged conflict. Bump to 120 before any bulk run
# unless told otherwise.
RATE_LIMIT_SECONDS = 1

# /ajax/ is explicitly Disallow'd for all user-agents in robots.txt.
# Do NOT use ajax/preview_course.php as a fallback data source; expanded
# content.php listings only.
