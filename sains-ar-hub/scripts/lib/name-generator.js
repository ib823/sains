'use strict';

/**
 * Generates realistic Malaysian names with correct ethnic distribution.
 * Malay 60%, Chinese 25%, Indian 15%
 */

const MALAY_MALE_FIRST = [
  'Ahmad', 'Muhammad', 'Mohd', 'Ali', 'Abu', 'Abdul', 'Hassan', 'Hussein', 'Ibrahim', 'Ismail',
  'Yusof', 'Yusuf', 'Khalid', 'Razak', 'Razali', 'Rahman', 'Rahim', 'Salleh', 'Hamid', 'Hamdan',
  'Zainal', 'Zulkifli', 'Zakaria', 'Mahmud', 'Mansor', 'Mat', 'Nasir', 'Najib', 'Noh', 'Omar',
  'Othman', 'Rosli', 'Roslan', 'Rashid', 'Sabri', 'Said', 'Saiful', 'Shafiq', 'Shahrul', 'Shukri',
  'Sufian', 'Syed', 'Tajul', 'Wahid', 'Yahya', 'Zaidi', 'Faizal', 'Fauzi', 'Hafiz', 'Hakim',
];

const MALAY_FEMALE_FIRST = [
  'Siti', 'Nur', 'Nurul', 'Fatimah', 'Aminah', 'Aishah', 'Aini', 'Azlina', 'Azura', 'Aziza',
  'Halimah', 'Hasniah', 'Hidayah', 'Intan', 'Jamaliah', 'Junaidah', 'Khadijah', 'Latifah', 'Maimunah', 'Mariam',
  'Marina', 'Mastura', 'Nadia', 'Najwa', 'Noraini', 'Norazlina', 'Norhayati', 'Norliza', 'Norma', 'Norazah',
  'Rabiah', 'Rafidah', 'Rahayu', 'Raihan', 'Ramlah', 'Rohana', 'Rohaya', 'Rosmah', 'Rosnah', 'Salbiah',
  'Salmah', 'Sarah', 'Shamsiah', 'Sharifah', 'Sumayyah', 'Suria', 'Wahida', 'Yati', 'Zainab', 'Zalina',
];

const MALAY_FAMILY = [
  'Abdullah', 'Abdul Rahman', 'Abdul Aziz', 'Hassan', 'Hussein', 'Ibrahim', 'Ismail', 'Yusof', 'Mohamed', 'Omar',
  'Othman', 'Rashid', 'Salleh', 'Sulaiman', 'Talib', 'Yahya', 'Zakaria', 'Mansor', 'Razak', 'Khalid',
  'Mohd Said', 'Mohd Noor', 'Abdul Latif', 'Bakar', 'Daud', 'Idris', 'Jamal', 'Karim', 'Rauf', 'Wahab',
];

const CHINESE_SURNAMES = [
  'Tan', 'Lee', 'Wong', 'Lim', 'Ng', 'Chan', 'Cheong', 'Chong', 'Chew', 'Choo',
  'Chua', 'Foo', 'Goh', 'Ho', 'Khoo', 'Koh', 'Kong', 'Lai', 'Lau', 'Leong',
  'Liew', 'Loh', 'Low', 'Mah', 'Ong', 'Pang', 'Phua', 'Quah', 'Saw', 'See',
  'Seah', 'Sim', 'Soh', 'Tay', 'Teh', 'Teo', 'Toh', 'Wee', 'Yap', 'Yeoh',
];

const CHINESE_GIVEN = [
  'Ah Chong', 'Ah Meng', 'Beng Hock', 'Boon Keat', 'Chee Seng', 'Chee Wai', 'Chin Hock', 'Chin Hooi', 'Choon Hong', 'Chun Wai',
  'Eng Hin', 'Hock Seng', 'Hong Beng', 'Jia Hao', 'Jian Wei', 'Kah Hoe', 'Kian Hong', 'Kim Cheong', 'Kok Wah', 'Kwong Ming',
  'Mei Ling', 'Mei Yee', 'Pei Shan', 'Siew Lan', 'Siew Mei', 'Su Lin', 'Sue Lin', 'Wei Chen', 'Wei Ling', 'Wei Ming',
  'Xiao Ming', 'Xin Yi', 'Yan Ling', 'Yee Mei', 'Ying Hui', 'Yoke Lin', 'Yu Hua', 'Yuen Mei', 'Zi Han', 'Zi Wei',
];

const INDIAN_FIRST = [
  'Anand', 'Arun', 'Ashok', 'Bala', 'Chandran', 'Devan', 'Ganesh', 'Gopal', 'Hari', 'Krishnan',
  'Kumar', 'Mohan', 'Mahesh', 'Murugan', 'Nathan', 'Prakash', 'Raja', 'Rajan', 'Ramesh', 'Ravi',
  'Devi', 'Geetha', 'Indira', 'Kala', 'Kamala', 'Lakshmi', 'Latha', 'Mala', 'Meena', 'Priya',
];

const INDIAN_SURNAMES = [
  'Muthu', 'Kumar', 'Pillai', 'Nair', 'Raju', 'Ramasamy', 'Subramaniam', 'Krishnan', 'Selvam', 'Maniam',
  'Govindasamy', 'Veerappan', 'Sundaram', 'Arumugam', 'Perumal', 'Chandran', 'Naidu', 'Reddy', 'Iyer', 'Menon',
];

function generateName(rng) {
  const ethnicityRoll = rng.next();
  let ethnicity, fullName, gender;

  if (ethnicityRoll < 0.60) {
    // Malay
    ethnicity = 'MALAY';
    if (rng.next() < 0.5) {
      gender = 'M';
      fullName = `${rng.pick(MALAY_MALE_FIRST)} bin ${rng.pick(MALAY_FAMILY)}`;
    } else {
      gender = 'F';
      fullName = `${rng.pick(MALAY_FEMALE_FIRST)} binti ${rng.pick(MALAY_FAMILY)}`;
    }
  } else if (ethnicityRoll < 0.85) {
    // Chinese
    ethnicity = 'CHINESE';
    gender = rng.next() < 0.5 ? 'M' : 'F';
    fullName = `${rng.pick(CHINESE_SURNAMES)} ${rng.pick(CHINESE_GIVEN)}`;
  } else {
    // Indian
    ethnicity = 'INDIAN';
    if (rng.next() < 0.5) {
      gender = 'M';
      fullName = `${rng.pick(INDIAN_FIRST)} a/l ${rng.pick(INDIAN_SURNAMES)}`;
    } else {
      gender = 'F';
      fullName = `${rng.pick(INDIAN_FIRST)} a/p ${rng.pick(INDIAN_SURNAMES)}`;
    }
  }

  return { fullName, gender, ethnicity };
}

module.exports = { generateName };
