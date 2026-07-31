from openai import OpenAI
import sys
import numpy as np
from sklearn.metrics.pairwise import cosine_similarity
import pandas as pd
import os
from sqlalchemy import create_engine
from dotenv import load_dotenv
load_dotenv()
# print("MYSQL_USER:", os.environ.get("MYSQL_USER"))
# print("MYSQL_HOST:", os.environ.get("MYSQL_HOST"))
# print("MYSQL_DATABASE:", os.environ.get("MYSQL_DATABASE"))


engine = create_engine(
    f"mysql+mysqlconnector://{os.environ['MYSQL_USER']}:{os.environ['MYSQL_PASSWORD']}"
    f"@{os.environ['MYSQL_HOST']}/{os.environ['MYSQL_DATABASE']}"
)

client = OpenAI(
    api_key=os.environ["GEMINI_API_KEY_1"],
    base_url="https://generativelanguage.googleapis.com/v1beta/openai/")

def get_embedding(text: str, model="gemini-embedding-001") -> list[float]:
    text = text.replace("\n", " ").strip()[:8000] # max token safety
    response = client.embeddings.create(model=model, input=text)
    return response.data[0].embedding
# Build embedding for a listing (combine key fields)
def build_listing_embedding(row: dict) -> list[float]:
    text = f"""
        {row["L_Type_"]} in {row["L_City"]}, CA.
        {row["L_Keyword2"]} beds, {row["LM_Dec_3"]} baths.
        {row["LM_Int2_3"]} sq ft. Built {row["YearBuilt"]}.
        Price: ${row["L_SystemPrice"]:,}.
        {row.get("L_Remarks", "")}
    """.strip()
    return get_embedding(text)
def find_similar_listings(
    query: str,
    listing_embeddings: list[tuple[str, list[float]]],
    top_k: int = 5
    ) -> list[str]:
    """Return top_k listing IDs most similar to the query."""
    query_vec = np.array(get_embedding(query)).reshape(1, -1)
    scores = []
    for listing_id, emb in listing_embeddings:
        sim = cosine_similarity(query_vec, np.array(emb).reshape(1, -1))[0][0]
        scores.append((listing_id, float(sim)))
    scores.sort(key=lambda x: x[1], reverse=True)
    return [lid for lid, _ in scores[:top_k]]
def fetch_sample_listings(city: str, limit: int = 5) -> pd.DataFrame:
    query = """
        SELECT
            L_ListingID, L_Type_, L_City, L_Keyword2, LM_Dec_3,
            LM_Int2_3, YearBuilt, L_SystemPrice, L_Remarks
        FROM rets_property
        WHERE L_Status = 'Active'
            AND LOWER(L_City) = LOWER(%s)
        LIMIT %s
    """
    return pd.read_sql(query, engine, params=(city, limit))

#test
# if __name__ == "__main__":
#     TEST_CITY = "San Jose"
#     df = fetch_sample_listings(TEST_CITY, limit=5)
 
#     if df.empty:
#         print(f"No active listings found for {TEST_CITY!r} — try a different city.")
#         raise SystemExit(0)
 
#     print(f"Fetched {len(df)} listings for {TEST_CITY}. Building embeddings...")
 
#     listing_embeddings = []
#     for _, row in df.iterrows():
#         emb = build_listing_embedding(row.to_dict())
#         listing_embeddings.append((row["L_ListingID"], emb))
#         print(f"  embedded listing {row['L_ListingID']}")
 
#     test_query = "modern 3 bedroom home with a large backyard, move-in ready"
#     print(f"\nQuery: {test_query!r}")
 
#     top_matches = find_similar_listings(test_query, listing_embeddings, top_k=3)
#     print("Top matching listing IDs:", top_matches)

if __name__ == "__main__":
     user_input = sys.argv[1]
     query = sys.argv[2]
     df = fetch_sample_listings(user_input, limit=5)
     if df.empty:
        print(f"No active listings found for {user_input!r} — try a different city.")
        raise SystemExit(0)
 
     print(f"Fetched {len(df)} listings for {user_input}. Building embeddings...")
 
     listing_embeddings = []
     for _, row in df.iterrows():
        emb = build_listing_embedding(row.to_dict())
        listing_embeddings.append((row["L_ListingID"], emb))
        print(f"  embedded listing {row['L_ListingID']}")
 
     print(f"\nQuery: {query!r}")
 
     top_matches = find_similar_listings(query, listing_embeddings, top_k=3)
     print("Top matching listing IDs:", top_matches)