import pandas as pd

df = pd.read_csv('ipl_master_calibrated.csv')

updates = [
    ('V Kohli', 2008, {'OVR': 76, 'Batting': 76}),
    ('MS Dhoni', 2009, {'Batting': 87}),
    ('SL Malinga', 2009, {'Batting': 69}),
    ('B Akhil', 2009, {'Batting': 72}),
    ('SA Yadav', 2015, {'Batting': 72}),
    ('AB de Villiers', 2010, {'OVR': 67, 'Batting': 69, 'Bowling': 55}),
    ('DA Warner', 2010, {'OVR': 83}),
    ('SL Malinga', 2010, {'OVR': 83}),
    ('RG Sharma', 2011, {'Batting': 83}),
    ('SL Malinga', 2013, {'Batting': 69}),
    ('SR Tendulkar', 2013, {'Batting': 81}),
    ('SA Yadav', 2014, {'Batting': 81}),
    ('CH Gayle', 2014, {'Batting': 82}),
    ('V Kohli', 2014, {'Batting': 85}),
    ('V Kohli', 2015, {'OVR': 86}),
    ('CR Brathwaite', 2016, {'Bowling': 80}),
    ('HH Pandya', 2016, {'OVR': 73}),
    ('SL Malinga', 2017, {'Batting': 69, 'Bowling': 83}),
    ('I Sharma', 2017, {'OVR': 74, 'Bowling': 74}),
    ('CH Gayle', 2017, {'Batting': 84}),
    ('V Kohli', 2017, {'Batting': 83}),
    ('MS Dhoni', 2018, {'OVR': 86}),
    ('V Kohli', 2019, {'OVR': 86}),
    ('SL Malinga', 2019, {'OVR': 87}),
    ('MS Dhoni', 2020, {'Bowling': 55, 'Batting': 82}),
    ('RG Sharma', 2020, {'Batting': 86}),
    ('DA Warner', 2020, {'OVR': 88}),
    ('AB de Villiers', 2021, {'OVR': 88}),
    ('MS Dhoni', 2021, {'Batting': 80}),
    ('HH Pandya', 2021, {'Batting': 79}),
    ('CH Gayle', 2021, {'OVR': 81, 'Batting': 79, 'Bowling': 55}),
    ('V Kohli', 2021, {'Batting': 85}),
    ('DA Warner', 2021, {'OVR': 77, 'Batting': 75}),
    ('Avesh Khan', 2022, {'OVR': 87, 'Bowling': 87}),
    ('RG Sharma', 2022, {'Batting': 82, 'Bowling': 55}),
    ('V Kohli', 2022, {'Batting': 84, 'Bowling': 55}),
    ('MS Dhoni', 2023, {'OVR': 81, 'Batting': 81, 'Bowling': 55}),
    ('RV Patel', 2023, {'Batting': 71}),
    ('RG Sharma', 2023, {'Batting': 85}),
    ('DA Warner', 2024, {'OVR': 74, 'Batting': 75, 'Bowling': 55}),
    ('MS Dhoni', 2025, {'OVR': 81, 'Batting': 83, 'Bowling': 55}),
    ('Akash Deep', 2025, {'Bowling': 75}),
    ('V Kohli', 2025, {'OVR': 87}),
    ('Avesh Khan', 2026, {'Bowling': 78}),
    ('Shashank Singh', 2026, {'Batting': 83}),
    ('Akash Deep', 2025, {'OVR': 72, 'Bowling': 69}),
    ('D Ferreira', 2026, {'Batting': 84}),
    ('TH David', 2026, {'Batting': 86}),

    # === REALISM CALIBRATION (Jun 2026) ===
    # Bat_Rat too low vs OVR despite elite stats
    ('Shashank Singh', 2024, {'Batting': 84}),   # 354r 44.2avg 164.7SR — OVR=88
    ('Shashank Singh', 2025, {'Batting': 82}),   # 350r 50.0avg 153.5SR — OVR=86
    ('SA Yadav', 2022, {'Batting': 84}),         # 303r 43.3avg 145.7SR — OVR=86

    # Underrated OVR vs actual season performance
    ('N Pooran', 2022, {'OVR': 82, 'Batting': 83}),    # 306r 38.2avg 144SR at SRH
    ('RA Jadeja', 2019, {'OVR': 82, 'Bowl_Rat': 82}),  # 15 wkts 6.35eco + good bat
    ('RA Jadeja', 2021, {'OVR': 84, 'Bowl_Rat': 84}),  # 13 wkts 7.06eco + 227r 75.7avg

    # Overrated for specific bad/injury season
    ('GJ Maxwell', 2024, {'OVR': 72, 'Batting': 70}),        # injury: 52r 5.8avg
    ('Shahbaz Ahmed', 2021, {'OVR': 73, 'Batting': 72, 'Bowling': 72}),  # 59r 8.4avg
    ('HH Pandya', 2021, {'Batting': 74}),                     # 127r 14.1avg 113SR
]

count = 0
for player, year, attr_updates in updates:
    mask = (df['Player_Name'] == player) & (df['Season'] == year)
    if not df[mask].empty:
        for attr, val in attr_updates.items():
            col_name = attr
            if attr == 'Batting': col_name = 'Bat_Rat'
            if attr == 'Bowling': col_name = 'Bowl_Rat'
            df.loc[mask, col_name] = val
        count += 1
    else:
        print(f"Not found: {player} {year}")

df.to_csv('ipl_master_calibrated.csv', index=False)
print(f"Updated {count} records.")
