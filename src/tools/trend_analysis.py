import pandas as pd
import os
from sqlalchemy import create_engine
from dotenv import load_dotenv
load_dotenv()

engine = create_engine(
    f"mysql+mysqlconnector://{os.environ['MYSQL_USER']}:{os.environ['MYSQL_PASSWORD']}"
    f"@{os.environ['MYSQL_HOST']}/{os.environ['MYSQL_DATABASE']}"
)

# Monthly price trends for a city
def get_price_trend(city: str, months: int = 24):
    query = """
    SELECT
        DATE_FORMAT(CloseDate, "%Y-%m") AS month,
            COUNT(*) AS sales,
            ROUND(AVG(ClosePrice), 0) AS avg_price,
            ROUND(AVG(DaysOnMarket), 1) AS avg_dom
        FROM california_sold
        WHERE City = %s
            AND PropertyType = 'Residential'
            AND CloseDate >= DATE_SUB(CURDATE(), INTERVAL %s MONTH)
        GROUP BY DATE_FORMAT(CloseDate, "%Y-%m")
        ORDER BY month
        ;
    """
    df = pd.read_sql(query, engine, params=(city, months))
    df["price_change_pct"] = df["avg_price"].pct_change() * 100
    return df


# city = sys.argv[1]
# df = get_price_trend(city)
# check_query = """
#     SELECT MIN(CloseDate) AS earliest, MAX(CloseDate) AS latest, COUNT(*) AS total_rows
#     FROM california_sold
#     WHERE City = %s AND PropertyType = 'Residential'
# """
# print(pd.read_sql(check_query, engine, params=('Irvine',)))
# print(pd.read_sql("SHOW COLUMNS FROM california_sold LIKE 'CloseDate'", engine))
# print(df)

