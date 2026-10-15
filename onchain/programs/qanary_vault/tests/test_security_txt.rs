//! Both binaries carry a security.txt in the neodyme-labs/solana-security-txt format, which explorers
//! read straight from the deployed program: `key\0value\0` pairs between fixed begin and end markers,
//! with a `.security.txt` ELF section holding a pointer to that string and its length.

const BEGIN: &[u8] = b"=======BEGIN SECURITY.TXT V1=======\0";
const END: &[u8] = b"=======END SECURITY.TXT V1=======\0";
/// Fields the format defines; parsers reject any other.
const KNOWN: [&str; 12] = [
    "name",
    "project_url",
    "contacts",
    "policy",
    "preferred_languages",
    "encryption",
    "source_code",
    "source_release",
    "source_revision",
    "auditors",
    "acknowledgements",
    "expiry",
];
const CONTACT_TYPES: [&str; 6] = ["email", "discord", "telegram", "twitter", "link", "other"];

fn expected(name: &'static str) -> Vec<(&'static str, &'static str)> {
    vec![
        ("name", name),
        ("project_url", "https://qanary.xyz"),
        ("contacts", "link:https://github.com/tradersirin-hash/qanary/security/advisories/new,link:https://x.com/Qanaryxyz"),
        ("policy", "https://github.com/tradersirin-hash/qanary/blob/main/SECURITY.md"),
        ("preferred_languages", "en"),
        ("source_code", "https://github.com/tradersirin-hash/qanary"),
        ("auditors", "None"),
    ]
}

fn binary(program: &str) -> Vec<u8> {
    let path = std::path::Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("../deploy/{program}.so"));
    std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

fn u64_at(b: &[u8], at: usize) -> usize {
    u64::from_le_bytes(b[at..at + 8].try_into().unwrap()) as usize
}

fn u32_at(b: &[u8], at: usize) -> usize {
    u32::from_le_bytes(b[at..at + 4].try_into().unwrap()) as usize
}

fn u16_at(b: &[u8], at: usize) -> usize {
    u16::from_le_bytes(b[at..at + 2].try_into().unwrap()) as usize
}

/// (name, virtual address, file offset, size) of every section of a little-endian ELF64 file.
fn sections(elf: &[u8]) -> Vec<(String, usize, usize, usize)> {
    let (shoff, shentsize, shnum, shstrndx) = (u64_at(elf, 0x28), u16_at(elf, 0x3a), u16_at(elf, 0x3c), u16_at(elf, 0x3e));
    let header = |i: usize| &elf[shoff + i * shentsize..][..shentsize];
    let names = u64_at(header(shstrndx), 24);
    (0..shnum)
        .map(|i| {
            let h = header(i);
            let name = elf[names + u32_at(h, 0)..].split(|&b| b == 0).next().unwrap();
            (String::from_utf8(name.to_vec()).unwrap(), u64_at(h, 16), u64_at(h, 24), u64_at(h, 32))
        })
        .collect()
}

fn positions(haystack: &[u8], needle: &[u8]) -> Vec<usize> {
    haystack.windows(needle.len()).enumerate().filter(|(_, w)| *w == needle).map(|(i, _)| i).collect()
}

/// Checks the security.txt of `program` and returns its fields in order.
fn security_txt(program: &str) -> Vec<(String, String)> {
    let elf = binary(program);
    // A second marker anywhere in the binary would confuse parsers that scan for the first one.
    let (begin, end) = (positions(&elf, BEGIN), positions(&elf, END));
    assert_eq!((begin.len(), end.len()), (1, 1), "{program}: exactly one begin and one end marker");
    let (start, stop) = (begin[0], end[0] + END.len());
    assert!(start < stop, "{program}: end marker after the begin marker");

    // The section holds a &str: the virtual address and length of exactly that string.
    let sections = sections(&elf);
    let (_, _, offset, size) =
        sections.iter().find(|s| s.0 == ".security.txt").unwrap_or_else(|| panic!("{program}: no .security.txt section"));
    assert_eq!(*size, 16, "{program}: pointer and length");
    let (address, len) = (u64_at(&elf, *offset), u64_at(&elf, offset + 8));
    let (_, base, file, _) = sections
        .iter()
        .find(|(_, a, _, s)| *a <= address && address + len <= a + s)
        .unwrap_or_else(|| panic!("{program}: .security.txt points outside every section"));
    assert_eq!((file + (address - base), len), (start, stop - start), "{program}: .security.txt points at the marked string");

    let body = std::str::from_utf8(&elf[start + BEGIN.len()..stop - END.len()]).expect("UTF-8");
    let parts: Vec<&str> = body.strip_suffix('\0').expect("NUL after the last value").split('\0').collect();
    assert_eq!(parts.len() % 2, 0, "{program}: key/value pairs");
    let fields: Vec<(String, String)> = parts.chunks(2).map(|kv| (kv[0].to_string(), kv[1].to_string())).collect();

    let keys: std::collections::BTreeSet<&str> = fields.iter().map(|(k, _)| k.as_str()).collect();
    assert_eq!(keys.len(), fields.len(), "{program}: no duplicate fields");
    assert!(keys.iter().all(|k| KNOWN.contains(k)), "{program}: only known fields");
    assert!(["name", "project_url", "contacts", "policy"].iter().all(|k| keys.contains(k)), "{program}: required fields");
    let contacts = &fields.iter().find(|(k, _)| k == "contacts").unwrap().1;
    for contact in contacts.split(',') {
        let (kind, info) = contact.split_once(':').unwrap_or_else(|| panic!("{program}: contact {contact:?}"));
        assert!(CONTACT_TYPES.contains(&kind) && !info.is_empty(), "{program}: contact {contact:?}");
    }
    assert!(!body.contains('@'), "{program}: no email addresses");
    fields
}

#[test]
fn both_binaries_carry_a_well_formed_security_txt() {
    for (program, name) in [("qanary_bounty", "Qanary Bounty"), ("qanary_vault", "Qanary Vault")] {
        let fields = security_txt(program);
        let fields: Vec<(&str, &str)> = fields.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
        assert_eq!(fields, expected(name), "{program}");
    }
}
