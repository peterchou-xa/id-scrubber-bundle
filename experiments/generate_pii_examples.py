#!/usr/bin/env python3
"""Generate 5000 messy OCR-style PII training examples and append to pii_train.jsonl.

Covers W-2/paystub, ID card, medical, bank, booking, shipping, résumé, utility bill,
DL/passport, loan, insurance, 1099, lease, voter-reg, boarding pass, email sig, and
pure-noise styles. OCR distortions include form-label intrusion, line breaks mid-value,
column merges, repeated copies, character swaps, and international formats.
"""
from __future__ import annotations
import json, random, string, os, sys

random.seed(1337)

OUT = os.path.join(os.path.dirname(__file__), "pii_train.jsonl")
N = 5000

# ── Pools (deliberately disjoint from names already in pii_train.jsonl) ──
FIRST = [
    "Marcus","Priya","Hiroshi","Amara","Viktor","Nadia","Mateo","Chloe","Ravi","Zara",
    "Felix","Ingrid","Dmitri","Leila","Omar","Yuki","Silas","Fatima","Bastian","Anika",
    "Tariq","Elena","Jin","Rosa","Kofi","Sven","Adaeze","Nikolai","Camille","Raj",
    "Bianca","Sergei","Maya","Esteban","Keiko","Arjun","Sabine","Pedro","Lena","Ibrahim",
    "Clara","Hakim","Freya","Tomas","Amelia","Yusuf","Greta","Pablo","Noor","Stefan",
    "Eun","Mateus","Hana","Desmond","Valeria","Oskar","Indira","Lucien","Meera","Grigor",
    "Thandiwe","Tobias","Saskia","Cornelius","Anastasia","Ulf","Minerva","Bartholomew",
    "Xiulan","Konstantin","Asha","Rafael","Ines","Wendell","Odette","Kiran","Solveig",
]
LAST = [
    "Okonkwo","Kowalski","Petrov","Nakamura","Fernandez","Bergstrom","Al-Hassan","Vasquez",
    "Delacroix","Nguyen","Abramowitz","Singh","Iverson","Morales","Dubois","Yamamoto",
    "Bianchi","Lindgren","Chowdhury","Rothstein","Silva","Mueller","Kovalenko","Papadopoulos",
    "Sandoval","Blackwood","Ferreira","Oduya","Kristiansen","Calloway","Vargas","Hoffmann",
    "Reyes","Novak","Azikiwe","Tanaka","Brennan","Rasmussen","Leclerc","Montgomery",
    "Whitaker","Kaczmarek","Siddiqui","Grimaldi","Ortega","Hendricks","Valentino","Saarinen",
    "Ashford","Brockman","Duvall","Eastwood","Galloway","Holbrook","Ingersoll","Jernigan",
    "Kettering","Lockhart","Merriweather","Nesbitt","Ostrowski","Pendleton","Quintero",
    "Radcliffe","Stavropoulos","Thorvaldsen","Underwood","Vermeulen","Winterbottom","Yazdani",
]
TITLES = ["Mr","Ms","Mrs","Dr","Prof","Rev","Capt","Sgt","Hon"]
SUFFIX = ["Jr","Sr","II","III","IV","PhD","MD","Esq"]

STREETS = [
    "OAK","ELM","CEDAR","PINE","BIRCH","CHESTNUT","WALNUT","SYCAMORE","MAGNOLIA","POPLAR",
    "ASH","HICKORY","DOGWOOD","JUNIPER","LAUREL","SPRUCE","ASPEN","CYPRESS","KINGS","QUEENS",
    "JEFFERSON","MADISON","LINCOLN","WILSON","HARRISON","GRANT","FILLMORE","MONROE","PIERCE",
    "TYLER","POLK","HAWTHORNE","RIVERSIDE","LAKEVIEW","HILLCREST","PARKWOOD","BAYSHORE",
    "MEADOW","CLOVER","WILLOWBROOK","SUNSET","BROADWAY","CENTER","CHURCH","MILL","BRIDGE",
]
SUFFIXES = ["ST","AVE","BLVD","LN","RD","DR","WAY","CT","PL","TER","PKWY","CIR","TRL"]
DIRS = ["","N","S","E","W","NE","NW","SE","SW"]

CITIES = [
    ("PHOENIX","AZ","85001"),("AUSTIN","TX","78701"),("DENVER","CO","80202"),
    ("PORTLAND","OR","97201"),("BOSTON","MA","02101"),("SEATTLE","WA","98101"),
    ("MIAMI","FL","33101"),("CHICAGO","IL","60601"),("ATLANTA","GA","30301"),
    ("NASHVILLE","TN","37201"),("COLUMBUS","OH","43201"),("KANSAS CITY","MO","64101"),
    ("SALT LAKE CITY","UT","84101"),("RALEIGH","NC","27601"),("MINNEAPOLIS","MN","55401"),
    ("BALTIMORE","MD","21201"),("PROVIDENCE","RI","02901"),("CHARLESTON","SC","29401"),
    ("ALBUQUERQUE","NM","87101"),("LOUISVILLE","KY","40201"),("MEMPHIS","TN","38101"),
    ("DES MOINES","IA","50301"),("HARTFORD","CT","06101"),("RICHMOND","VA","23219"),
    ("JACKSONVILLE","FL","32201"),("OKLAHOMA CITY","OK","73102"),("TULSA","OK","74103"),
    ("LAS VEGAS","NV","89101"),("RENO","NV","89501"),("BOISE","ID","83702"),
    ("MILWAUKEE","WI","53202"),("CINCINNATI","OH","45202"),("PITTSFIELD","MA","01201"),
    ("BUFFALO","NY","14202"),("ROCHESTER","NY","14604"),("SYRACUSE","NY","13202"),
]
INTL_ADDR = [
    ("12 Rue de Rivoli","75001 PARIS","FR"),
    ("45 Unter den Linden","10117 BERLIN","DE"),
    ("88 Orchard Road","238839","SG"),
    ("22 St Kilda Rd","MELBOURNE VIC 3004","AU"),
    ("7 Calle Gran Via","28013 MADRID","ES"),
    ("199 Queen St","TORONTO ON M5H 2M6","CA"),
    ("14 Chome-1 Ginza","CHUO TOKYO 104-0061","JP"),
    ("3 Jalan Ampang","50450 KUALA LUMPUR","MY"),
    ("210 High Holborn","LONDON WC1V 7EP","UK"),
    ("77 Dundas St","DUBLIN 2 D02 XH91","IE"),
]

DOMAINS = ["gmail.com","yahoo.com","outlook.com","hotmail.com","icloud.com",
           "protonmail.com","aol.com","work.co","company.io","mail.org","fastmail.com"]
AREA = ["212","415","312","206","404","713","602","503","617","303","305","202","702",
        "615","646","347","718","213","310","415","650","408","858","619","469","214"]

COMPANIES = [
    "NORTHBRIDGE INDUSTRIES","ACME HOLDINGS","STELLAR DYNAMICS","PALADIN CORP",
    "REDWOOD PARTNERS LLC","QUANTUM LOGIC INC","SUMMIT CAPITAL","IRONGATE SYSTEMS",
    "VANGUARD ANALYTICS","NOVA TEXTILES","BLACKSTONE MEDIA","CRESCENT LOGISTICS",
    "HARBOR FREIGHT CO","PILGRIM MANUFACTURING","SILVERLAKE TECH LTD",
]

HOSPITALS = ["ST LUKE'S MEDICAL","MERCY HEALTH","REGIONAL CARE CENTER",
             "HILLSIDE CLINIC","UNIVERSITY HEALTH","NORTH PARK HOSPITAL"]

BANKS = ["FIRST NATIONAL","CAPITAL TRUST","MERIDIAN BANK","GOLDEN STATE FCU",
         "HARBOR SAVINGS","UNION CITY CU"]

INSURERS = ["BLUE SHIELD PLUS","GUARDIAN HEALTH","AETRA CARE","VIVO INSURANCE",
            "HORIZON HEALTHPLAN","PIONEER CASUALTY"]

NOISE_GLYPHS = ["·","•","|","→","►","~","^","@#%","||","**","..",";;"]
FORM_LABELS_EMP = [
    "e/f Employee's name, address, and ZIP code",
    "Employee Name and Address",
    "Recipient's name address and ZIP",
    "Name of Payee",
    "Cardholder",
    "Subscriber",
    "Account Holder",
    "Ship To",
    "Bill To",
    "Mail To",
    "Sold To",
]
FORM_LABELS_ER = [
    "c Employer's name, address, and ZIP code",
    "Payer's name address and ZIP",
    "b Employer identification number (EIN)",
    "Company address",
    "Issuer",
]
BOX_CODES = ["12a","12b","12c","12d","14H","14X","13","1.","2.","3.","4.","5.","6.",
             "7 Social security tips","8 Allocated tips","Box 1","Line 7","Line 12",
             "Dept.","Corp.","Control number","OMB No. 1545-0008","BATCH #12345",
             "PAGE 01 OF 01","PAGE 1 OF 3","REV 11/18/20","COPY C","COPY A"]
MONEY = ["$1,204.55","$249.99","$44,629.35","$7,631.62","$48,736.35","$706.68",
         "$1,000.00","$4,107.00","$1,500.00","$1,467.72","$478.08","$0.00","$31.53"]
DISTRACTOR_NUMS = ["Invoice 999-88-7777","Order #4111998877665544",
                   "Ticket 555-12-3456","Case 222-33-4444","Ref 9001-2345-6789"]


def rnd_name():
    first = random.choice(FIRST)
    last = random.choice(LAST)
    mid = random.choice(string.ascii_uppercase) if random.random() < 0.35 else ""
    if mid:
        name = f"{first} {mid} {last}"
    else:
        name = f"{first} {last}"
    if random.random() < 0.06:
        name = f"{random.choice(TITLES)} {name}"
    if random.random() < 0.05:
        name = f"{name} {random.choice(SUFFIX)}"
    if random.random() < 0.25:
        name = name.upper()
    return name


def rnd_street():
    num = random.randint(1, 9999)
    d = random.choice(DIRS)
    s = random.choice(STREETS)
    sfx = random.choice(SUFFIXES)
    parts = [str(num)]
    if d:
        parts.append(d)
    parts.extend([s, sfx])
    return " ".join(parts)


def rnd_city_state_zip():
    c, s, z = random.choice(CITIES)
    # sometimes use +4 zip
    if random.random() < 0.2:
        z = f"{z}-{random.randint(1000,9999)}"
    return c, s, z


def rnd_full_address():
    """Return (text, value) for an address.

    `value` is always the canonical inline form: 'Street, City, State ZIP'.
    `text` randomly chooses between the same inline form (with commas) and
    a multi-line form ('Street\\nCity, State ZIP') where the line break
    replaces the comma after the street.
    """
    street = rnd_street()
    c, s, z = rnd_city_state_zip()
    value = f"{street}, {c}, {s} {z}"
    if random.random() < 0.5:
        return value, value
    return f"{street}\n{c}, {s} {z}", value


def rnd_email(name_hint: str | None = None):
    if name_hint and random.random() < 0.6:
        p = name_hint.lower().replace("'", "").split()
        p = [x for x in p if x.isalpha() and x not in ("mr","ms","mrs","dr","prof","rev","capt","sgt","hon","jr","sr","ii","iii","iv","phd","md","esq")]
        if not p:
            p = [random.choice(FIRST).lower()]
        sep = random.choice([".","_","",""])
        local = sep.join(p[:2]) if len(p) >= 2 else p[0]
        if random.random() < 0.3:
            local += str(random.randint(1, 999))
    else:
        local = f"{random.choice(FIRST).lower()}{random.choice(['.','_',''])}{random.choice(LAST).lower().replace('-','')}"
    return f"{local}@{random.choice(DOMAINS)}"


def rnd_phone(style=None):
    a = random.choice(AREA)
    b = random.randint(200, 999)
    c = random.randint(0, 9999)
    return a, b, c


def fmt_phone(a, b, c, style):
    cs = f"{c:04d}"
    if style == "paren":
        return f"({a}) {b}-{cs}"
    if style == "dash":
        return f"{a}-{b}-{cs}"
    if style == "dot":
        return f"{a}.{b}.{cs}"
    if style == "plain":
        return f"{a}{b}{cs}"
    if style == "spaced":
        return f"{a} {b} {cs}"
    if style == "intl":
        return f"+1 {a} {b} {cs}"
    return f"({a}) {b}-{cs}"


def rnd_ssn():
    a = random.randint(100, 899)
    b = random.randint(10, 99)
    c = random.randint(1000, 9999)
    return a, b, c


def fmt_ssn(a, b, c, style):
    if style == "dash":
        return f"{a}-{b:02d}-{c:04d}"
    if style == "space":
        return f"{a} {b:02d} {c:04d}"
    if style == "plain":
        return f"{a}{b:02d}{c:04d}"
    if style == "nl":
        return f"{a}\n{b:02d}\n{c:04d}"
    return f"{a}-{b:02d}-{c:04d}"


def rnd_cc():
    bins_ = ["4111","4532","4024","5412","5555","3782","6011","3530"]
    bin_ = random.choice(bins_)
    g2 = f"{random.randint(0,9999):04d}"
    g3 = f"{random.randint(0,9999):04d}"
    g4 = f"{random.randint(0,9999):04d}"
    return bin_, g2, g3, g4


def fmt_cc(g1,g2,g3,g4, style):
    if style == "space":
        return f"{g1} {g2} {g3} {g4}"
    if style == "dash":
        return f"{g1}-{g2}-{g3}-{g4}"
    if style == "plain":
        return f"{g1}{g2}{g3}{g4}"
    if style == "nl":
        return f"{g1}\n{g2}\n{g3}\n{g4}"
    return f"{g1} {g2} {g3} {g4}"


def rnd_ip():
    return ".".join(str(random.randint(1,254)) for _ in range(4))


def rnd_dob():
    m = random.randint(1,12)
    d = random.randint(1,28)
    y = random.randint(1940, 2005)
    return m, d, y


def fmt_dob(m,d,y, style):
    if style == "slash":
        return f"{m:02d}/{d:02d}/{y}"
    if style == "dash":
        return f"{m:02d}-{d:02d}-{y}"
    if style == "dot":
        return f"{m:02d}.{d:02d}.{y}"
    if style == "spaced":
        return f"{m:02d} / {d:02d} / {y}"
    if style == "long":
        months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]
        return f"{months[m-1]} {d} {y}"
    return f"{m:02d}/{d:02d}/{y}"


def rnd_dl():
    letter = random.choice(string.ascii_uppercase)
    digits = "".join(random.choices(string.digits, k=random.choice([7,8,9])))
    return f"{letter}{digits}"


def rnd_passport():
    return random.choice(string.ascii_uppercase) + random.choice(string.ascii_uppercase) + "".join(random.choices(string.digits, k=7))


def rnd_acct():
    g = random.randint(1000, 9999)
    h = random.randint(1000, 9999)
    i = random.randint(1000, 9999)
    return g, h, i


def fmt_acct(g,h,i, style):
    if style == "dash":
        return f"{g}-{h}-{i}"
    if style == "space":
        return f"{g} {h} {i}"
    if style == "nl":
        return f"{g}\n{h}\n{i}"
    if style == "plain":
        return f"{g}{h}{i}"
    return f"{g}-{h}-{i}"


def rnd_empid():
    return f"EMP-{random.randint(100,99999):05d}"


def rnd_mrn():
    return f"MRN{random.randint(1000000,9999999)}"


def rnd_policy():
    return "".join(random.choices(string.ascii_uppercase + string.digits, k=random.choice([8,10,11])))


def rnd_booking():
    return "".join(random.choices(string.ascii_uppercase, k=6))


def rnd_noise(n=1):
    out = []
    for _ in range(n):
        r = random.random()
        if r < 0.3:
            out.append(random.choice(BOX_CODES))
        elif r < 0.55:
            out.append(random.choice(MONEY))
        elif r < 0.7:
            out.append(random.choice(NOISE_GLYPHS))
        elif r < 0.85:
            out.append(str(random.randint(1, 99999)))
        else:
            out.append(random.choice(["noise","box","cont.","see instr.","N/A","---"]))
    return " ".join(out)


def inject(tokens, extra_noise=0.3, nl=0.15):
    """Randomly insert noise between tokens and convert some spaces to newlines."""
    pieces = []
    for i, t in enumerate(tokens):
        if i > 0:
            if random.random() < extra_noise:
                pieces.append(rnd_noise(random.randint(1,2)))
            pieces.append("\n" if random.random() < nl else " ")
        pieces.append(t)
    return "".join(pieces)


# ── Template functions: return (text, pii_list) ──

def tpl_w2_employee():
    name = rnd_name()
    street = rnd_street()
    c, s, z = rnd_city_state_zip()
    addr_str = f"{street}, {c}, {s} {z}"
    label = random.choice(FORM_LABELS_EMP)
    parts = [label]
    parts.append(rnd_noise(random.randint(0,2)))
    parts.append(name)
    parts.append(rnd_noise(random.randint(0,2)))
    parts.append(street)
    parts.append(rnd_noise(random.randint(0,3)))
    parts.append(f"{c}, {s} {z}")
    parts.append(rnd_noise(random.randint(1,4)))
    text = "\n".join(p for p in parts if p)
    # sometimes add SSN masked + full SSN
    pii = [{"type":"full_name","value":name},
           {"type":"address","value":addr_str}]
    if random.random() < 0.35:
        a,b,cx = rnd_ssn()
        ssn = fmt_ssn(a,b,cx,random.choice(["dash","space"]))
        text += "\n" + random.choice(["a Employee's SSA number","SSN","Employee's SSN"]) + " " + ssn
        pii.append({"type":"social_security_number","value":f"{a}-{b:02d}-{cx:04d}"})
    if random.random() < 0.4:
        # add W-2 copy repeats
        text += "\n" + rnd_noise(3) + "\n" + name + "\n" + street + "\n" + f"{c}, {s} {z}"
    return text, pii


def tpl_w2_employer():
    comp = random.choice(COMPANIES)
    street = rnd_street()
    c, s, z = rnd_city_state_zip()
    addr_str = f"{street}, {c}, {s} {z}"
    label = random.choice(FORM_LABELS_ER)
    ein = f"{random.randint(10,99)}-{random.randint(1000000,9999999)}"
    parts = [label, rnd_noise(1), comp, rnd_noise(random.randint(0,2)),
             street, rnd_noise(random.randint(0,2)), f"{c}, {s} {z}",
             rnd_noise(1), f"EIN {ein}"]
    text = "\n".join(p for p in parts if p)
    pii = [{"type":"address","value":addr_str},
           {"type":"other_pii","value":f"EIN {ein}"}]
    return text, pii


def tpl_paystub():
    name = rnd_name()
    addr_text, addr = rnd_full_address()
    empid = rnd_empid()
    a,b,cx = rnd_ssn()
    ssn = fmt_ssn(a,b,cx,"dash")
    net = random.choice(MONEY)
    parts = ["PAY STATEMENT","Period Ending "+fmt_dob(*rnd_dob(),"slash"),
             "Employee", name, "ID "+empid, "SSN "+ssn,
             "Address:", addr_text,
             "Gross "+random.choice(MONEY),"YTD "+random.choice(MONEY),
             "Net "+net]
    random.shuffle(parts[3:])
    text = "\n".join(parts)
    return text, [
        {"type":"full_name","value":name},
        {"type":"address","value":addr},
        {"type":"other_pii","value":empid},
        {"type":"social_security_number","value":f"{a}-{b:02d}-{cx:04d}"},
    ]


def tpl_id_card():
    name = rnd_name().upper()
    pol = rnd_policy()
    payer = "".join(random.choices(string.ascii_uppercase, k=random.choice([4,5])))
    group = str(random.randint(100000,999999))
    insurer = random.choice(INSURERS)
    text = "\n".join([
        insurer, random.choice(["Member ID","Subscriber ID","Policyholder"])+":",
        name, "ID: "+pol,
        "Group: "+group, "Payer ID: "+payer,
        random.choice(["RxBIN","BIN"])+" "+str(random.randint(100000,999999)),
        "Effective "+fmt_dob(*rnd_dob(),"slash"),
    ])
    return text, [
        {"type":"full_name","value":name},
        {"type":"other_pii","value":"ID "+pol},
        {"type":"other_pii","value":"Group "+group},
    ]


def tpl_flight_booking():
    name = rnd_name()
    pp = rnd_passport()
    dob = fmt_dob(*rnd_dob(), "long")
    bref = rnd_booking()
    cref = f"{random.randint(10,99)}-{random.randint(100000000,999999999)}"
    email = rnd_email(name)
    nat = random.choice(["US","UK","CA","DE","FR","JP","SG","AU"])
    exp = f"20{random.randint(27,35)}-{random.randint(1,12):02d}-{random.randint(1,28):02d}"
    text = "\n".join([
        "Confirmed","Customer reference: "+cref,
        "PIN code: "+str(random.randint(1000,9999)),
        "Booking reference: "+bref,
        "Traveler details", name,
        f"Adult {random.choice(['Male','Female'])} {dob}",
        "Travel document details",
        f"{pp} {random.choice(['·','|','/'])} {nat} {random.choice(['·','|','/'])} {exp}",
        "Email: "+email,
    ])
    return text, [
        {"type":"full_name","value":name},
        {"type":"other_pii","value":"Booking "+bref},
        {"type":"other_pii","value":"Customer ref "+cref},
        {"type":"other_pii","value":"Passport "+pp},
        {"type":"date_of_birth","value":dob},
        {"type":"email_address","value":email},
    ]


def tpl_boarding_pass():
    name = rnd_name().upper()
    pnr = rnd_booking()
    seat = f"{random.randint(1,45)}{random.choice('ABCDEF')}"
    flight = random.choice(["UA","DL","AA","BA","LH","AF","KL","CZ"])+str(random.randint(100,9999))
    text = " ".join(["BOARDING PASS", name, "PNR", pnr, "FLT", flight, "SEAT", seat, "GATE", str(random.randint(1,99))])
    if random.random()<0.4:
        text = text.replace(" ","\n")
    return text, [
        {"type":"full_name","value":name},
        {"type":"other_pii","value":"PNR "+pnr},
    ]


def tpl_utility_bill():
    name = rnd_name().upper()
    street = rnd_street()
    c,s,z = rnd_city_state_zip()
    addr_str = f"{street}, {c}, {s} {z}"
    acct = str(random.randint(1000000000,9999999999))
    amt = random.choice(MONEY)
    # OCR garbage lines (mimics font-decoded bill)
    garbage = random.choice(["*/(. $/%","-!). 34","#$%& /()","@!@ ***","^^^~~~"])
    text = "\n".join([
        "Amount Due "+amt,
        "Account Number: "+acct,
        "Service For:", garbage, rnd_noise(1),
        name, street, f"{c}, {s} {z}",
        "Due Date "+fmt_dob(*rnd_dob(),"slash"),
    ])
    return text, [
        {"type":"full_name","value":name},
        {"type":"address","value":addr_str},
        {"type":"other_pii","value":"Account "+acct},
    ]


def tpl_medical():
    name = rnd_name()
    mrn = rnd_mrn()
    dob = fmt_dob(*rnd_dob(), random.choice(["slash","dash"]))
    a,b,cx = rnd_ssn()
    ssn_val = f"{a}-{b:02d}-{cx:04d}"
    dr = "Dr. "+random.choice(LAST)
    text = "\n".join([
        random.choice(HOSPITALS),"Patient Chart",
        "Patient: "+name,"DOB: "+dob,"MRN: "+mrn,"SSN: "+ssn_val,
        "Provider: "+dr,"Visit: "+fmt_dob(*rnd_dob(),"slash"),
        "ICD-10 "+random.choice(["J06.9","I10","E11.9","R51","M54.5"]),
        "BP "+f"{random.randint(100,140)}/{random.randint(60,90)}",
    ])
    return text, [
        {"type":"full_name","value":name},
        {"type":"full_name","value":dr},
        {"type":"date_of_birth","value":dob},
        {"type":"other_pii","value":mrn},
        {"type":"social_security_number","value":ssn_val},
    ]


def tpl_prescription():
    patient = rnd_name()
    doctor = "Dr. "+random.choice(LAST)
    rxnum = str(random.randint(100000,9999999))
    drug = random.choice(["Lisinopril 10mg","Atorvastatin 20mg","Metformin 500mg","Amoxicillin 250mg","Sertraline 50mg"])
    text = "\n".join([
        "Prescription",
        "Patient: "+patient,
        "Rx#: "+rxnum,
        "Medication: "+drug,
        "Prescriber: "+doctor,
        "Refills "+str(random.randint(0,5)),
    ])
    return text, [
        {"type":"full_name","value":patient},
        {"type":"full_name","value":doctor},
        {"type":"other_pii","value":"Rx# "+rxnum},
    ]


def tpl_bank_statement():
    name = rnd_name()
    g,h,i = rnd_acct()
    acct_val = f"{g}-{h}-{i}"
    acct_fmt = fmt_acct(g,h,i,random.choice(["dash","space","nl"]))
    routing = str(random.randint(100000000,999999999))
    ip = rnd_ip()
    bank = random.choice(BANKS)
    addr_text, addr = rnd_full_address()
    text = "\n".join([
        bank+" Statement",
        "Account holder: "+name,
        "Address: "+addr_text,
        "Account #: "+acct_fmt,
        "Routing: "+routing,
        "Balance "+random.choice(MONEY),
        "Login IP: "+ip,
    ])
    return text, [
        {"type":"full_name","value":name},
        {"type":"address","value":addr},
        {"type":"bank_account_number","value":acct_val},
        {"type":"other_pii","value":"Routing "+routing},
        {"type":"ip_address","value":ip},
    ]


def tpl_check():
    name = rnd_name().upper()
    addr_text, addr = rnd_full_address()
    g,h,i = rnd_acct()
    acct_val = f"{g}-{h}-{i}"
    routing = str(random.randint(100000000,999999999))
    text = "\n".join([
        name, addr_text, "PAY TO THE ORDER OF "+rnd_name(),
        random.choice(MONEY),
        f"⑉{routing}⑉ {g}{h}{i}⑈ "+str(random.randint(1000,9999)),
    ])
    return text, [
        {"type":"full_name","value":name},
        {"type":"address","value":addr},
        {"type":"bank_account_number","value":acct_val},
        {"type":"other_pii","value":"Routing "+routing},
    ]


def tpl_cc_statement():
    name = rnd_name()
    g1,g2,g3,g4 = rnd_cc()
    cc_val = f"{g1} {g2} {g3} {g4}"
    cc_fmt = fmt_cc(g1,g2,g3,g4,random.choice(["space","dash","nl"]))
    addr_text, addr = rnd_full_address()
    text = "\n".join([
        "VISA STATEMENT","Cardholder "+name,"Billing Address",addr_text,
        "Card Number "+cc_fmt,
        "Exp "+f"{random.randint(1,12):02d}/{random.randint(27,32)}",
        "CVV ***","Balance "+random.choice(MONEY),
    ])
    return text, [
        {"type":"full_name","value":name},
        {"type":"address","value":addr},
        {"type":"credit_card_number","value":cc_val},
    ]


def tpl_shipping_label():
    s_name = rnd_name()
    s_addr_text, s_addr = rnd_full_address()
    r_name = rnd_name()
    r_addr_text, r_addr = rnd_full_address()
    track = "1Z"+"".join(random.choices(string.ascii_uppercase+string.digits,k=16))
    text = "\n".join([
        "FROM:", s_name, s_addr_text,
        "TO:", r_name, r_addr_text,
        "TRACKING "+track,
        "WEIGHT "+str(random.randint(1,50))+" LBS",
    ])
    return text, [
        {"type":"full_name","value":s_name},
        {"type":"address","value":s_addr},
        {"type":"full_name","value":r_name},
        {"type":"address","value":r_addr},
        {"type":"other_pii","value":"Tracking "+track},
    ]


def tpl_resume():
    name = rnd_name()
    email = rnd_email(name)
    a,b,cx = rnd_phone(); phone = fmt_phone(a,b,cx,random.choice(["paren","dash","dot"]))
    city,st,_ = rnd_city_state_zip()
    sep = random.choice([" | "," · "," • ","\n"])
    text = sep.join([name, email, phone, f"{city}, {st}"])
    text += "\n\nEXPERIENCE\n"+random.choice(COMPANIES)+" — "+random.choice(["Engineer","Manager","Analyst","Designer"])
    return text, [
        {"type":"full_name","value":name},
        {"type":"email_address","value":email},
        {"type":"phone_number","value":f"({a}) {b}-{cx:04d}"},
    ]


def tpl_email_sig():
    name = rnd_name()
    email = rnd_email(name)
    a,b,cx = rnd_phone(); phone = fmt_phone(a,b,cx,"paren")
    title = random.choice(["Senior Engineer","VP of Sales","Director","Account Executive"])
    text = "\n".join(["--",name,title,random.choice(COMPANIES),email,phone])
    return text, [
        {"type":"full_name","value":name},
        {"type":"email_address","value":email},
        {"type":"phone_number","value":f"({a}) {b}-{cx:04d}"},
    ]


def tpl_dl():
    name = rnd_name().upper()
    dl = rnd_dl()
    dob = fmt_dob(*rnd_dob(),"slash")
    addr_text, addr = rnd_full_address()
    cls = random.choice(["C","M","A","B","CDL"])
    text = "\n".join([
        random.choice(["CALIFORNIA","TEXAS","NEW YORK","FLORIDA","OHIO"])+" DRIVER LICENSE",
        "DL "+dl,"CLASS "+cls,"DOB "+dob,
        name, addr_text,
        "EXP "+fmt_dob(*rnd_dob(),"slash"),
        "SEX "+random.choice(["M","F"]),"EYES "+random.choice(["BRN","BLU","GRN","HAZ"]),
    ])
    return text, [
        {"type":"full_name","value":name},
        {"type":"address","value":addr},
        {"type":"date_of_birth","value":dob},
        {"type":"other_pii","value":"DL "+dl},
    ]


def tpl_passport():
    name = rnd_name().upper()
    pp = rnd_passport()
    dob = fmt_dob(*rnd_dob(),"long")
    nat = random.choice(["USA","GBR","CAN","DEU","FRA","JPN"])
    text = "\n".join([
        "PASSPORT","Type P","Code "+nat,
        "Surname "+name.split()[-1],"Given Names "+" ".join(name.split()[:-1]),
        "Passport No. "+pp,
        "Date of Birth "+dob,
        "Sex "+random.choice(["M","F"]),
        "Place of Birth "+random.choice([c[0] for c in CITIES]),
        "Date of Expiry "+fmt_dob(*rnd_dob(),"long"),
    ])
    return text, [
        {"type":"full_name","value":name},
        {"type":"date_of_birth","value":dob},
        {"type":"other_pii","value":"Passport "+pp},
    ]


def tpl_1099():
    name = rnd_name()
    tin = f"XXX-XX-{random.randint(1000,9999)}"
    payer = random.choice(COMPANIES)
    street = rnd_street(); c,s,z = rnd_city_state_zip()
    addr_val = f"{street}, {c}, {s} {z}"
    text = "\n".join([
        "Form 1099-NEC","PAYER "+payer,
        "RECIPIENT's TIN "+tin,
        "RECIPIENT "+name,
        street, f"{c}, {s} {z}",
        "1 Nonemployee compensation "+random.choice(MONEY),
    ])
    return text, [
        {"type":"full_name","value":name},
        {"type":"address","value":addr_val},
        {"type":"other_pii","value":"TIN "+tin},
    ]


def tpl_loan_app():
    name = rnd_name()
    addr_text, addr = rnd_full_address()
    a,b,cx = rnd_ssn(); ssn = f"{a}-{b:02d}-{cx:04d}"
    dob = fmt_dob(*rnd_dob(),"slash")
    ap,bp,cp = rnd_phone(); phone = fmt_phone(ap,bp,cp,"paren")
    email = rnd_email(name)
    text = "\n".join([
        "URLA LOAN APPLICATION",
        "Borrower: "+name,
        "SSN: "+ssn,"DOB: "+dob,
        "Current Address: "+addr_text,
        "Phone "+phone,"Email "+email,
        "Annual Income "+random.choice(MONEY),
        "Employer "+random.choice(COMPANIES),
    ])
    return text, [
        {"type":"full_name","value":name},
        {"type":"address","value":addr},
        {"type":"social_security_number","value":ssn},
        {"type":"date_of_birth","value":dob},
        {"type":"phone_number","value":f"({ap}) {bp}-{cp:04d}"},
        {"type":"email_address","value":email},
    ]


def tpl_voter_reg():
    name = rnd_name()
    addr_text, addr = rnd_full_address()
    dob = fmt_dob(*rnd_dob(),"slash")
    vid = str(random.randint(1000000,99999999))
    text = "\n".join([
        "VOTER REGISTRATION","Name "+name,"Residence "+addr_text,
        "DOB "+dob,"Voter ID "+vid,
        "Party "+random.choice(["DEM","REP","IND","GRN","LIB","NP"]),
        "Precinct "+str(random.randint(1,400)),
    ])
    return text, [
        {"type":"full_name","value":name},
        {"type":"address","value":addr},
        {"type":"date_of_birth","value":dob},
        {"type":"other_pii","value":"Voter ID "+vid},
    ]


def tpl_lease():
    name = rnd_name()
    addr_text, addr = rnd_full_address()
    text = "\n".join([
        "RESIDENTIAL LEASE AGREEMENT",
        "This Lease is between Landlord "+rnd_name()+" and Tenant "+name,
        "Premises: "+addr_text,
        "Term "+str(random.randint(6,36))+" months",
        "Rent "+random.choice(MONEY)+" per month",
    ])
    return text, [
        {"type":"full_name","value":name},
        {"type":"address","value":addr},
    ]


def tpl_invoice():
    name = rnd_name()
    addr_text, addr = rnd_full_address()
    email = rnd_email(name)
    inv = "INV-"+str(random.randint(10000,999999))
    text = "\n".join([
        "INVOICE "+inv,
        "Bill To:", name, addr_text, email,
        "Subtotal "+random.choice(MONEY),
        "Tax "+random.choice(MONEY),
        "TOTAL "+random.choice(MONEY),
    ])
    return text, [
        {"type":"full_name","value":name},
        {"type":"address","value":addr},
        {"type":"email_address","value":email},
    ]


def tpl_hotel_folio():
    name = rnd_name()
    conf = str(random.randint(10000000,99999999))
    email = rnd_email(name)
    ap,bp,cp = rnd_phone(); phone = fmt_phone(ap,bp,cp,"dash")
    g1,g2,g3,g4 = rnd_cc()
    last4 = g4
    text = "\n".join([
        random.choice(["MARRIOTT","HILTON","HYATT","FOUR SEASONS","RITZ"])+" GUEST FOLIO",
        "Guest: "+name,
        "Confirmation #: "+conf,
        "Email "+email,"Phone "+phone,
        "Card on file ****-****-****-"+last4,
        "Check-in "+fmt_dob(*rnd_dob(),"slash"),
    ])
    return text, [
        {"type":"full_name","value":name},
        {"type":"email_address","value":email},
        {"type":"phone_number","value":f"{ap}-{bp}-{cp:04d}"},
        {"type":"other_pii","value":"Confirmation "+conf},
    ]


def tpl_intl_address():
    name = rnd_name()
    street, cityline, cc = random.choice(INTL_ADDR)
    addr_val = f"{street} {cityline} {cc}"
    parts = [name, street, rnd_noise(random.randint(0,2)), cityline, cc]
    text = inject(parts)
    return text, [
        {"type":"full_name","value":name},
        {"type":"address","value":addr_val},
    ]


def tpl_intl_phone():
    name = rnd_name()
    country = random.choice(["+44","+49","+33","+81","+65","+61","+86"])
    num = " ".join(str(random.randint(10,999)) for _ in range(random.randint(2,4)))
    phone_val = f"{country} {num}"
    text = f"{name} {random.choice(['Tel','Phone','Contact','M'])}: {phone_val}"
    return text, [
        {"type":"full_name","value":name},
        {"type":"phone_number","value":phone_val},
    ]


def tpl_plain_name():
    name = rnd_name()
    prefix = random.choice(["","Dear ","To: ","Attn: ","Customer: ","Mr. ","Ms. "])
    suffix = random.choice(["",", thank you",", please sign below",", welcome!",", account holder"])
    text = f"{prefix}{name}{suffix}"
    return text, [{"type":"full_name","value":name}]


def tpl_plain_email():
    name = rnd_name()
    email = rnd_email(name)
    styles = [
        email,
        email.replace("@"," @ ").replace("."," . "),
        email.replace("@"," at "),
        f"Contact: {email}",
        f"email→{email}",
        email.replace("@","\n@\n"),
    ]
    return random.choice(styles), [{"type":"email_address","value":email}]


def tpl_plain_phone():
    a,b,c = rnd_phone()
    style = random.choice(["paren","dash","dot","plain","spaced","intl"])
    text = fmt_phone(a,b,c,style)
    if random.random()<0.4:
        text = f"{random.choice(['Tel','Cell','Mobile','Ph','M'])}: {text}"
    return text, [{"type":"phone_number","value":f"({a}) {b}-{c:04d}"}]


def tpl_plain_ssn():
    a,b,c = rnd_ssn()
    style = random.choice(["dash","space","plain","nl"])
    label = random.choice(["SSN","SSN:","Social Security","TIN","TAX ID"])
    text = f"{label} {fmt_ssn(a,b,c,style)}"
    return text, [{"type":"social_security_number","value":f"{a}-{b:02d}-{c:04d}"}]


def tpl_plain_cc():
    g = rnd_cc()
    style = random.choice(["space","dash","plain","nl"])
    label = random.choice(["Card","CARD","Card #","CC","Payment"])
    text = f"{label} {fmt_cc(*g,style)}"
    return text, [{"type":"credit_card_number","value":f"{g[0]} {g[1]} {g[2]} {g[3]}"}]


def tpl_plain_ip():
    ip = rnd_ip()
    label = random.choice(["IP","Login IP","Source","Remote","Client IP","IPv4"])
    variants = [ip, ip.replace("."," . "), ip.replace("."," "), ip.replace(".","\n.")]
    return f"{label} {random.choice(variants)}", [{"type":"ip_address","value":ip}]


def tpl_noise_only():
    bits = [
        "Server uptime OK nothing to report",
        "Build passed 123 tests in 4.2s",
        "Transaction approved REF "+random.choice(DISTRACTOR_NUMS),
        "Meeting notes: Q3 targets unchanged",
        "ERROR 500 internal server",
        "Invoice total "+random.choice(MONEY),
        "Temperature 68F humidity 42",
        "END OF PAGE NO DATA",
        "Disclaimer: this communication is confidential",
        random.choice(BOX_CODES)+" "+random.choice(MONEY),
        random.choice(DISTRACTOR_NUMS),
    ]
    return random.choice(bits), []


def tpl_multicol_merge():
    # Two rows collapsed: NameA AddrA_street NameB AddrB_street CityA StateA Zip CityB StateB Zip
    n1 = rnd_name(); s1 = rnd_street(); c1,st1,z1 = rnd_city_state_zip()
    n2 = rnd_name(); s2 = rnd_street(); c2,st2,z2 = rnd_city_state_zip()
    tokens = [n1, n2, s1, s2, f"{c1}, {st1} {z1}", f"{c2}, {st2} {z2}"]
    text = inject(tokens, extra_noise=0.1, nl=0.5)
    return text, [
        {"type":"full_name","value":n1},
        {"type":"full_name","value":n2},
        {"type":"address","value":f"{s1}, {c1}, {st1} {z1}"},
        {"type":"address","value":f"{s2}, {c2}, {st2} {z2}"},
    ]


def tpl_ocr_char_swap():
    # realistic OCR char errors in name/addr
    name = rnd_name()
    addr_text, addr = rnd_full_address()
    swapped = addr_text
    for a,b in [("0","O"),("O","0"),("1","l"),("l","1"),("S","5")]:
        if random.random() < 0.25:
            swapped = swapped.replace(a,b,1)
    # keep value clean; text is garbled
    text = f"{name}\n{swapped}"
    return text, [
        {"type":"full_name","value":name},
        {"type":"address","value":addr},
    ]


def tpl_address_fragmented():
    name = rnd_name()
    street = rnd_street()
    c,s,z = rnd_city_state_zip()
    # heavy noise between street and city/state/zip (user's key example)
    mid = " ".join([rnd_noise(1) for _ in range(random.randint(3,6))])
    text = f"{name}\n{street}, {mid} {c}, {s} {z}"
    return text, [
        {"type":"full_name","value":name},
        {"type":"address","value":f"{street}, {c}, {s} {z}"},
    ]


def tpl_repeated_copy():
    name = rnd_name()
    addr_text, addr = rnd_full_address()
    # W-2 has multiple copies of same address
    copies = random.randint(2,4)
    chunks = []
    for _ in range(copies):
        chunks.append(f"{name}\n{addr_text}\n"+rnd_noise(2))
    text = "\n".join(chunks)
    return text, [
        {"type":"full_name","value":name},
        {"type":"address","value":addr},
    ]


def tpl_form_field_soup():
    # Form with many field labels and PII buried
    name = rnd_name()
    addr_text, addr = rnd_full_address()
    a,b,cx = rnd_ssn(); ssn = f"{a}-{b:02d}-{cx:04d}"
    labels = ["First Name","Last Name","Middle Initial","Date","Signature","Title",
              "Department","Location","Supervisor","Witness","Badge #","Shift"]
    random.shuffle(labels)
    buried = [labels[0], name.split()[0], labels[1], name.split()[-1],
              "Address", addr_text, "SSN", ssn, labels[2], labels[3], labels[4]]
    return "\n".join(buried), [
        {"type":"full_name","value":name},
        {"type":"address","value":addr},
        {"type":"social_security_number","value":ssn},
    ]


def tpl_jury_summons():
    name = rnd_name()
    addr_text, addr = rnd_full_address()
    case = f"CV-{random.randint(10,25)}-{random.randint(10000,99999)}"
    text = "\n".join([
        "SUPERIOR COURT","JURY SUMMONS",
        "Case No. "+case,
        name, addr_text,
        "Report Date "+fmt_dob(*rnd_dob(),"slash"),
        "Juror #"+str(random.randint(100,9999)),
    ])
    return text, [
        {"type":"full_name","value":name},
        {"type":"address","value":addr},
        {"type":"other_pii","value":"Case "+case},
    ]


def tpl_student_record():
    name = rnd_name()
    sid = "S"+str(random.randint(10000000,99999999))
    dob = fmt_dob(*rnd_dob(),"slash")
    parent = rnd_name()
    addr_text, addr = rnd_full_address()
    text = "\n".join([
        "OFFICIAL TRANSCRIPT",
        "Student: "+name,
        "ID: "+sid,"DOB: "+dob,
        "Guardian: "+parent,"Home Address: "+addr_text,
        "GPA "+f"{random.uniform(2.0,4.0):.2f}",
    ])
    return text, [
        {"type":"full_name","value":name},
        {"type":"full_name","value":parent},
        {"type":"date_of_birth","value":dob},
        {"type":"address","value":addr},
        {"type":"other_pii","value":"Student ID "+sid},
    ]


def tpl_insurance_claim():
    name = rnd_name()
    claim = "CLM-"+str(random.randint(100000,999999))
    policy = rnd_policy()
    addr_text, addr = rnd_full_address()
    text = "\n".join([
        random.choice(INSURERS)+" CLAIM",
        "Claimant "+name,
        "Policy # "+policy,"Claim # "+claim,
        "Address "+addr_text,
        "Date of Loss "+fmt_dob(*rnd_dob(),"slash"),
        "Amount "+random.choice(MONEY),
    ])
    return text, [
        {"type":"full_name","value":name},
        {"type":"address","value":addr},
        {"type":"other_pii","value":"Policy "+policy},
        {"type":"other_pii","value":"Claim "+claim},
    ]


def tpl_name_addr_split_by_label():
    # User's key example: label text interleaves name and address
    name = rnd_name()
    street = rnd_street()
    c,s,z = rnd_city_state_zip()
    label = random.choice(FORM_LABELS_EMP + FORM_LABELS_ER)
    extra = random.choice(["1. Your Gross Pay was adjusted as follows","BATCH #"+str(random.randint(1000,99999)),
                           "See instructions for box 12","Copy C for employee's records"])
    text = f"{label} {name} {street}, {c}, {s} {z} {rnd_noise(2)} {extra}"
    return text, [
        {"type":"full_name","value":name},
        {"type":"address","value":f"{street}, {c}, {s} {z}"},
    ]


def tpl_masked_and_full_ssn():
    name = rnd_name()
    a,b,c = rnd_ssn()
    full = f"{a}-{b:02d}-{c:04d}"
    masked = f"XXX-XX-{c:04d}"
    text = f"{name}\nSSN (masked): {masked}\nEmployee SSA number: {full}"
    return text, [
        {"type":"full_name","value":name},
        {"type":"social_security_number","value":full},
    ]


def tpl_distractor_numbers():
    # Only distractor-looking numbers, no real PII
    text = "\n".join([
        random.choice(DISTRACTOR_NUMS),
        "Order Total "+random.choice(MONEY),
        "PO #"+str(random.randint(1000000,9999999)),
    ])
    return text, []


TEMPLATES = [
    (tpl_w2_employee,        10),
    (tpl_w2_employer,         4),
    (tpl_paystub,             5),
    (tpl_id_card,             5),
    (tpl_flight_booking,      5),
    (tpl_boarding_pass,       3),
    (tpl_utility_bill,        5),
    (tpl_medical,             5),
    (tpl_prescription,        3),
    (tpl_bank_statement,      4),
    (tpl_check,               3),
    (tpl_cc_statement,        4),
    (tpl_shipping_label,      4),
    (tpl_resume,              3),
    (tpl_email_sig,           3),
    (tpl_dl,                  4),
    (tpl_passport,            3),
    (tpl_1099,                3),
    (tpl_loan_app,            3),
    (tpl_voter_reg,           2),
    (tpl_lease,               2),
    (tpl_invoice,             3),
    (tpl_hotel_folio,         3),
    (tpl_intl_address,        3),
    (tpl_intl_phone,          2),
    (tpl_plain_name,          4),
    (tpl_plain_email,         4),
    (tpl_plain_phone,         4),
    (tpl_plain_ssn,           3),
    (tpl_plain_cc,            3),
    (tpl_plain_ip,            2),
    (tpl_noise_only,          6),
    (tpl_multicol_merge,      3),
    (tpl_ocr_char_swap,       3),
    (tpl_address_fragmented,  5),
    (tpl_repeated_copy,       3),
    (tpl_form_field_soup,     3),
    (tpl_jury_summons,        2),
    (tpl_student_record,      3),
    (tpl_insurance_claim,     3),
    (tpl_name_addr_split_by_label, 6),
    (tpl_masked_and_full_ssn, 2),
    (tpl_distractor_numbers,  2),
]

population = []
for fn, w in TEMPLATES:
    population.extend([fn]*w)


def main():
    rows = []
    for _ in range(N):
        fn = random.choice(population)
        try:
            text, pii = fn()
        except Exception as e:
            continue
        rows.append({"ocr_text": text, "pii": pii})
    with open(OUT, "a", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(f"appended {len(rows)} rows to {OUT}")


if __name__ == "__main__":
    main()
